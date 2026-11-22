import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type Field, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { licenseTerms, onePhylogeny, sourceKeyOf } from '../src/index.js'
import { recordCollections } from '../src/records.js'

let payload: Payload
let mongo: MongoMemoryReplSet
let animal: string

type User = { id: string; collection: string; role: string; site?: string }
const superAdmin = { id: 'sa1', collection: 'users', role: 'super-admin' } as never
const admin = { id: 'a1', collection: 'users', role: 'admin' } as never
const staff = { id: 's1', collection: 'users', role: 'staff', site: 'site-1' } as never
const roleOf = (req: { user?: unknown }) => (req.user as User | null)?.role
const isSuperAdmin = ({ req }: { req: { user?: unknown } }) => roleOf(req) === 'super-admin'
const isAdmin = ({ req }: { req: { user?: unknown } }) => ['admin', 'super-admin'].includes(roleOf(req) ?? '')

const SHA = 'a'.repeat(64)
const source = (over: Record<string, unknown> = {}) => ({ sourceType: 'public-database', accession: `MK${Math.floor(Math.random() * 1e9)}`, database: 'GenBank', ...over })
const create = (data: Record<string, unknown>) => payload.create({ collection: 'samples' as never, depth: 0, data: { subject: animal, tenant: 'site-1', ...data } as never }) as Promise<Record<string, unknown>>
const external = (over: Record<string, unknown> = {}, ext: Record<string, unknown> = {}) => create({ origin: 'external', external: source(ext), ...over })
const update = (id: unknown, data: Record<string, unknown>, user?: unknown) => payload.update({ collection: 'samples' as never, id: id as never, data: data as never, ...(user ? { user: user as never, overrideAccess: false } : {}) })
const readAs = (id: unknown, user: unknown) => payload.findByID({ collection: 'samples' as never, id: id as never, user: user as never, overrideAccess: false }) as Promise<Record<string, unknown>>

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  payload = await getPayload({ config: await buildConfig({
    secret: 'test-secret-not-for-production', telemetry: false, typescript: { autoGenerate: false },
    db: mongooseAdapter({ url: mongo.getUri('external'), ensureIndexes: true }),
    collections: [
      { slug: 'users', auth: true, fields: [{ name: 'role', type: 'text' }, { name: 'site', type: 'text' }] },
      { slug: 'animals', fields: [{ name: 'name', type: 'text' }] },
      { slug: 'kits', fields: [{ name: 'code', type: 'text' }] },
      { slug: 'source-releases', fields: [{ name: 'name', type: 'text' }] },
      { slug: 'import-runs', fields: [{ name: 'name', type: 'text' }] },
    ],
    plugins: [
      onePhylogeny({
        relations: { subject: 'animals' }, manageAccess: isAdmin as never,
        records: {
          relations: { kit: 'kits' },
          readAccess: (({ req }: any) => (req.user?.site ? { tenant: { equals: req.user.site } } : false)) as never,
          external: { restrictedAccess: isSuperAdmin as never, urlAccess: isAdmin as never, relations: { sourceReleases: 'source-releases', importRuns: 'import-runs' } },
          ecoregions: { land: { dataset: 'RESOLVE Ecoregions', version: '2017' } },
        },
      }),
      // A host's tenant field, as a multi-tenant plugin would add it.
      (config) => ({ ...config, collections: config.collections!.map((c) => ['samples', 'sequences', 'assignments'].includes(c.slug) ? { ...c, fields: [...c.fields, { name: 'tenant', type: 'text' }] } : c) }),
    ],
  }) })
  animal = String((await payload.create({ collection: 'animals' as never, data: { name: 'Made-up reference tortoise' } as never })).id)
}, 120000)
afterAll(async () => { await payload?.destroy(); await mongo?.stop() })

describe('origin', () => {
  it('is internal by default, and an internal sample has no external source and needs how it arrived', async () => {
    const kit = String((await payload.create({ collection: 'kits' as never, data: { code: 'K1' } as never })).id)
    const sample = await create({ source: 'kit', kit })
    expect(sample.origin).toBe('internal')
    await expect(create({ source: 'kit', external: { sourceType: 'paper' } })).rejects.toThrow(/has no external source/)
    await expect(create({})).rejects.toThrow(/needs how its material arrived/)
    // An empty group, as the admin sends it, is not a source.
    await expect(create({ source: 'upload', external: { voucher: {}, accession: '' } })).resolves.toMatchObject({ origin: 'internal' })
  })
  it('external samples need a source type and never carry a kit, consent or source', async () => {
    const kit = String((await payload.create({ collection: 'kits' as never, data: { code: 'K2' } as never })).id)
    await expect(create({ origin: 'external' })).rejects.toThrow(/needs its source type/)
    await expect(create({ origin: 'external', external: { accession: 'X1' } })).rejects.toThrow(/needs its source type/)
    await expect(external({ kit })).rejects.toThrow(/has no kit/)
    await expect(external({ consent: 'yes' })).rejects.toThrow(/has no keeper consent/)
    await expect(external({ source: 'historic' })).rejects.toThrow(/has no source/)
    const ok = await external({}, { sourceType: 'paper', citation: 'Made-up et al. (2001)', doi: '10.0000/made-up' })
    expect(ok).toMatchObject({ origin: 'external', external: { sourceType: 'paper', citation: 'Made-up et al. (2001)' } })
  })
  it('is set once', async () => {
    const internal = await create({ source: 'historic' })
    await expect(update(internal.id, { origin: 'external', external: source() })).rejects.toThrow(/can't change/)
    const ext = await external()
    await expect(update(ext.id, { origin: 'internal', source: 'historic' })).rejects.toThrow(/can't change/)
    // An edit that leaves the group alone still has to keep the rules: no kit can be added later.
    const kit = String((await payload.create({ collection: 'kits' as never, data: { code: 'K3' } as never })).id)
    await expect(update(ext.id, { kit })).rejects.toThrow(/can't change|has no kit/)
  })
  it('relates to the host\'s source release and import run when given', async () => {
    const release = String((await payload.create({ collection: 'source-releases' as never, data: { name: 'Made-up release 1' } as never })).id)
    const run = String((await payload.create({ collection: 'import-runs' as never, data: { name: 'run-1' } as never })).id)
    const s = await external({}, { sourceType: 'public-database', accession: 'REL1', database: 'ENA', sourceRelease: release, importRun: run })
    expect(s.external).toMatchObject({ sourceRelease: release, importRun: run })
  })
})

describe('accession and database', () => {
  // The stored document, as the database holds it, so the tests see the hidden key and whether it is missing or null.
  const stored = async (id: unknown) => (await (payload.db as unknown as { collections: Record<string, { findById: (id: unknown) => { lean: () => Promise<Record<string, unknown>> } }> }).collections.samples!.findById(id).lean()) as { external?: Record<string, unknown> }
  const dup = /already records/

  it('are unique together where both are set, and a sample may keep its own', async () => {
    const first = await external({}, { accession: 'AB000001', database: 'GenBank' })
    expect((await stored(first.id)).external?.sourceKey).toBe('genbank:ab000001')
    await expect(external({}, { accession: 'AB000001', database: 'GenBank' })).rejects.toThrow(/already records GenBank AB000001/)
    await expect(external({}, { accession: 'AB000001', database: 'ENA' })).resolves.toBeTruthy()
    await expect(update(first.id, { external: { citation: 'A corrected citation' } })).resolves.toMatchObject({ external: { accession: 'AB000001', citation: 'A corrected citation' } })
    const other = await external({}, { accession: 'AB000002', database: 'GenBank' })
    await expect(update(other.id, { external: { accession: 'AB000001' } })).rejects.toThrow(/already records GenBank AB000001/)
    // A key sent by a client is replaced with the plugin's own.
    const forged = await external({}, { accession: 'AB000003', database: 'GenBank', sourceKey: 'genbank:ab000001' })
    expect((await stored(forged.id)).external?.sourceKey).toBe('genbank:ab000003')
  })
  it('leave the key unset when either part is blank, so blanks never collide', async () => {
    const ids = [
      await external({}, { accession: 'AB000001', database: null }),
      await external({}, { accession: 'AB000001', database: null }),
      await external({}, { accession: null, database: 'GenBank' }),
      await external({}, { accession: null, database: 'GenBank' }),
      await external({}, { sourceType: 'paper', accession: undefined, database: undefined }),
      await external({}, { sourceType: 'paper', accession: '', database: '  ' }),
    ].map((s) => s.id)
    for (const id of ids) expect('sourceKey' in ((await stored(id)).external ?? {})).toBe(false)
    expect(sourceKeyOf('GenBank', '')).toBeUndefined()
    expect(sourceKeyOf(null, 'AB1')).toBeUndefined()
  })
  it('read the database and accession without regard to case or spacing', async () => {
    await external({}, { accession: 'AB000010', database: 'GenBank' })
    await expect(external({}, { accession: 'AB000010', database: 'genbank' })).rejects.toThrow(/already records genbank AB000010/)
    await expect(external({}, { accession: 'ab000010', database: 'GENBANK' })).rejects.toThrow(dup)
    await expect(external({}, { accession: ' AB 000010 ', database: ' Gen  Bank ' })).rejects.toThrow(dup)
    expect(sourceKeyOf(' Gen  Bank ', ' ab 000010 ')).toBe('genbank:ab000010')
    const s = await external({}, { accession: 'AB000011', database: 'GenBank' })
    await expect(update(s.id, { external: { accession: 'ab000010' } })).rejects.toThrow(dup)
  })
  it('end concurrent creates of the same pair with exactly one saved, each refusal in plain words', async () => {
    const same = { accession: 'AB000020', database: 'GenBank' }
    const results = await Promise.allSettled([external({}, same), external({}, same), external({}, same)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    // Inside a MongoDB transaction the loser sees a write conflict, which names no key, so it is told a write collided
    // and which pair it most likely was; a loser that reached the index itself gets the exact message.
    for (const r of results) if (r.status === 'rejected') expect(String((r.reason as Error).message)).toMatch(/already records GenBank AB000020|most likely a sample with GenBank AB000020/)
    const found = await payload.find({ collection: 'samples' as never, where: { 'external.sourceKey': { equals: 'genbank:ab000020' } } as never, overrideAccess: true })
    expect(found.totalDocs).toBe(1)
    // The retry meets the hook's check and the exact message.
    await expect(external({}, same)).rejects.toThrow(/already records GenBank AB000020\. Edit that sample/)
  })
  it('have the index behind the hook, and its own refusal reads the same', async () => {
    // Straight to the adapter, past the hook, so the index itself is what refuses the second write.
    const raw = (ext: Record<string, unknown>) => payload.db.create({ collection: 'samples', data: { subject: animal, origin: 'external', external: { sourceType: 'public-database', ...ext } } })
    await raw({ accession: 'AB000030', database: 'GenBank', sourceKey: 'genbank:ab000030' })
    await expect(raw({ accession: 'AB000030', database: 'GenBank', sourceKey: 'genbank:ab000030' })).rejects.toThrow(/already records GenBank AB000030\. Edit that sample/)
    // Any other unique field's refusal is left as Payload reports it.
    await expect(payload.db.create({ collection: 'samples', data: { subject: animal, origin: 'external', external: { sourceType: 'paper' } } })).resolves.toBeTruthy()
  })
  it('drop the key when an update clears the accession, and never write an explicit null', async () => {
    const a = await external({}, { accession: 'AB000040', database: 'GenBank' })
    const b = await external({}, { accession: 'AB000041', database: 'GenBank' })
    await update(a.id, { external: { accession: null } })
    await update(b.id, { external: { accession: null } })
    for (const s of [a, b]) {
      const ext = (await stored(s.id)).external ?? {}
      expect('sourceKey' in ext).toBe(false)
      expect(ext.database).toBe('GenBank')
    }
    // The pair is free again once a sample lets it go.
    await expect(external({}, { accession: 'AB000040', database: 'GenBank' })).resolves.toBeTruthy()
    // An update that leaves the group alone keeps the key.
    const c = await external({}, { accession: 'AB000042', database: 'GenBank' })
    await update(c.id, { material: 'tissue' })
    expect((await stored(c.id)).external?.sourceKey).toBe('genbank:ab000042')
  })
})

describe('restricted fields', () => {
  const secrets = { collector: 'A. Collector', permit: 'PERMIT-1', url: 'https://example.com/record/1' }
  it('show the collector and permit only to the host\'s restricted check, and the url only to its url check', async () => {
    const s = await external({}, { ...source(), ...secrets })
    expect(await readAs(s.id, superAdmin)).toMatchObject({ external: secrets })
    const asAdmin = (await readAs(s.id, admin)).external as Record<string, unknown>
    expect(asAdmin.collector).toBeUndefined()
    expect(asAdmin.permit).toBeUndefined()
    expect(asAdmin.url).toBe(secrets.url)
    expect(asAdmin.accession).toBeTruthy()
    const asStaff = (await readAs(s.id, staff)).external as Record<string, unknown>
    expect(asStaff.collector).toBeUndefined()
    expect(asStaff.permit).toBeUndefined()
    expect(asStaff.url).toBeUndefined()
    expect(asStaff.accession).toBeTruthy()
    const listed = await payload.find({ collection: 'samples' as never, where: { id: { equals: s.id } } as never, user: admin, overrideAccess: false })
    expect((listed.docs[0] as Record<string, unknown>).external).not.toHaveProperty('collector')
  })
  it('refuse a change to the collector or permit from anyone but the restricted check', async () => {
    const s = await external({}, { ...source(), ...secrets })
    await update(s.id, { external: { collector: 'Someone else', permit: 'PERMIT-2' } }, admin).catch(() => undefined)
    expect(await readAs(s.id, superAdmin)).toMatchObject({ external: { collector: 'A. Collector', permit: 'PERMIT-1' } })
    await update(s.id, { external: { collector: 'Corrected name' } }, superAdmin)
    expect(await readAs(s.id, superAdmin)).toMatchObject({ external: { collector: 'Corrected name', permit: 'PERMIT-1' } })
  })
  it('are hidden from everyone when the host passes no checks', async () => {
    const { collections } = recordCollections({}, { panels: 'panels', assignments: 'assignments', manage: () => true, againstShown: false })
    const fields = (collections[0]!.fields.find((f) => 'name' in f && f.name === 'external') as { fields: Field[] }).fields
    const byName = (n: string) => fields.find((f) => 'name' in f && f.name === n) as { access: { read: (a: unknown) => unknown; update?: (a: unknown) => unknown } }
    const req = { req: { user: superAdmin } }
    for (const n of ['collector', 'permit']) {
      expect(await byName(n).access.read(req)).toBe(false)
      expect(await byName(n).access.update!(req)).toBe(false)
    }
    expect(await byName('url').access.read(req)).toBe(false)
    expect(fields.some((f) => 'name' in f && f.name === 'sourceRelease')).toBe(false)
  })
})

describe('data license', () => {
  it('fails closed: unknown, unstated or other means pointer only', () => {
    // `other` has terms only a person can read, so the plugin answers the same as for no license at all.
    for (const l of ['unknown', 'other', undefined, null, 'made-up']) expect(licenseTerms(l)).toEqual({ keepCopy: false, redistribute: false, commercial: false, pointerOnly: true })
    expect(licenseTerms('cc0')).toEqual({ keepCopy: true, redistribute: true, commercial: true, pointerOnly: false })
    expect(licenseTerms('insdc').redistribute).toBe(true)
    expect(licenseTerms('cc-by-nc')).toMatchObject({ redistribute: true, commercial: false })
  })
  it('refuses a cache copy under other, the same as under unknown', async () => {
    const s = await external({}, { ...source(), dataLicense: 'other', dataLicenseNote: 'Made-up terms, see the paper.' })
    await expect(update(s.id, { rawReads: [{ pointer: 'SRR000003', sha256: SHA, tier: 'cache' }] })).rejects.toThrow(/only a pointer/)
    await expect(update(s.id, { rawReads: [{ pointer: 'SRR000003', sha256: SHA, tier: 'external' }] })).resolves.toBeTruthy()
  })
  it('is unknown when the source gives none, and then no copy of its reads may be kept', async () => {
    const s = await external()
    expect((s.external as Record<string, unknown>).dataLicense).toBe('unknown')
    await expect(update(s.id, { rawReads: [{ pointer: 'SRR000001', sha256: SHA, tier: 'cache' }] })).rejects.toThrow(/license is unknown, so only a pointer/)
    await expect(update(s.id, { rawReads: [{ pointer: 'SRR000001', sha256: SHA, tier: 'hot' }] })).rejects.toThrow(/stay the source's/)
    await expect(update(s.id, { rawReads: [{ pointer: 'SRR000001', sha256: SHA, tier: 'external' }] })).resolves.toBeTruthy()
    await expect(update(s.id, { external: { dataLicense: 'cc-by' }, rawReads: [{ pointer: 'SRR000001', sha256: `sha256:${SHA.toUpperCase()}`, tier: 'cache', fetchedAt: new Date().toISOString() }] }))
      .resolves.toMatchObject({ rawReads: [{ tier: 'cache', sha256: SHA }] })
  })
  it('keeps the host\'s own reads in its own tiers, with a real checksum', async () => {
    const s = await create({ source: 'upload' })
    await expect(update(s.id, { rawReads: [{ pointer: 'reads/1.fastq.gz', sha256: SHA, tier: 'external' }] })).rejects.toThrow(/hot or deep-archive/)
    await expect(update(s.id, { rawReads: [{ pointer: 'reads/1.fastq.gz', sha256: SHA, tier: 'cache' }] })).rejects.toThrow(/hot or deep-archive/)
    await expect(update(s.id, { rawReads: [{ pointer: 'reads/1.fastq.gz', sha256: 'abc', tier: 'hot' }] })).rejects.toThrow(/SHA-256 is missing or malformed \(reads\/1.fastq.gz\)/)
    await expect(update(s.id, { rawReads: [{ pointer: 'reads/1.fastq.gz', sha256: SHA, tier: 'deep-archive', bytes: 1024 }] })).resolves.toMatchObject({ rawReads: [{ tier: 'deep-archive', bytes: 1024 }] })
  })
})

describe('ecoregion', () => {
  it('is pinned by version per realm, and never a coordinate', async () => {
    const s = await external()
    await expect(update(s.id, { ecoregion: { land: { code: '1', name: 'Made-up moist forest' } } })).rejects.toThrow(/land ecoregion needs the dataset and version/)
    await expect(update(s.id, { ecoregion: { land: { code: '1', name: 'Made-up moist forest', dataset: 'RESOLVE Ecoregions', version: '2016' } } })).rejects.toThrow(/are RESOLVE Ecoregions 2017; RESOLVE Ecoregions 2016 isn't that set/)
    await expect(update(s.id, { ecoregion: { land: { code: '1', name: 'Made-up moist forest', dataset: 'RESOLVE Ecoregions', version: '2017' }, source: 'curator' } })).resolves.toMatchObject({ ecoregion: { land: { version: '2017' }, source: 'curator' } })
    await expect(update(s.id, { ecoregion: { marine: { code: '20001', name: 'Made-up shelf' } } })).rejects.toThrow(/marine ecoregion needs the dataset and version/)
    await expect(update(s.id, { ecoregion: { marine: { code: '20001', name: 'Made-up shelf', dataset: 'MEOW', version: '2007' }, freshwater: { code: '301', name: 'Made-up basin', dataset: 'FEOW', version: '2008' } } })).resolves.toMatchObject({ ecoregion: { marine: { dataset: 'MEOW' }, freshwater: { dataset: 'FEOW' } } })
    await expect(create({ origin: 'external', external: source(), latitude: 0 })).rejects.toThrow(/never hold coordinates/)
    await expect(update(s.id, { rawReads: [{ pointer: 'SRR000002', sha256: SHA, tier: 'external', coordinates: '0,0' }] })).rejects.toThrow(/never hold coordinates/)
  })
})
