import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { parseGenBank, sha256Hex } from '@extantape/onephylogeny-core'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { readFileSync } from 'node:fs'
import { buildConfig, createLocalReq, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { datePrecision, genBankToExternalSample, importGenBank, licenseTerms, looksLikeCoordinates, onePhylogeny } from '../src/index.js'

// Five real public GenBank records (see fixtures/external/README.md). Nothing here is from Captive Origins.
const fixture = readFileSync(new URL('../../../fixtures/external/cytb-chelonoidis-carbonarius.gb', import.meta.url), 'utf8')
const ACCESSIONS = ['PQ562694', 'PQ562693', 'PQ562692', 'PQ562691', 'PQ562690']
/** An EDITED COPY of the first fixture record, with a made-up accession and extra source qualifiers, so nobody takes it for a real one. */
const edited = (accession: string, qualifiers: string[]) =>
  fixture.split(/^\/\/\s*$/m)[0]!.replace(/PQ562694/g, accession)
    .replace('/geo_loc_name="Colombia"', ['/geo_loc_name="Colombia"', ...qualifiers].join('\n                     ')) + '//\n'

// Made-up users. The host's rules: curators manage samples, any signed-in user reads them, nobody sees the source link.
type User = { id: string; collection: string; role: string }
const curator = { id: 'c1', collection: 'users', role: 'curator' } as never
const reader = { id: 'r1', collection: 'users', role: 'reader' } as never
const roleOf = ({ req }: { req: { user?: unknown } }) => (req.user as User | null)?.role

let payload: Payload
let mongo: MongoMemoryReplSet
let animal: string
const stored = async () => (await payload.find({ collection: 'samples' as never, limit: 100, depth: 0, pagination: false })).docs as unknown as Record<string, any>[]
const clear = async () => { await payload.delete({ collection: 'samples' as never, where: { id: { exists: true } } as never }) }
/** What a read with no user signed in gets: Payload refuses it outright. */
const anonymousRead = () => payload.find({ collection: 'samples' as never, depth: 0, overrideAccess: false })
const readAs = (user: unknown) => payload.find({ collection: 'samples' as never, depth: 0, limit: 100, user: user as never, overrideAccess: false }).then((r) => r.docs as unknown as Record<string, any>[])

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  payload = await getPayload({ config: await buildConfig({
    secret: 'test-secret-not-for-production', telemetry: false, typescript: { autoGenerate: false },
    db: mongooseAdapter({ url: mongo.getUri('import'), ensureIndexes: true }),
    collections: [
      { slug: 'users', auth: true, fields: [{ name: 'role', type: 'text' }] },
      { slug: 'animals', fields: [{ name: 'name', type: 'text' }] },
    ],
    plugins: [onePhylogeny({
      relations: { subject: 'animals' },
      manageAccess: ((a: { req: { user?: unknown } }) => roleOf(a) === 'curator') as never,
      records: { readAccess: (({ req }: { req: { user?: unknown } }) => Boolean(req.user)) as never, external: {} },
    })],
  }) })
  animal = String((await payload.create({ collection: 'animals' as never, data: { name: 'Made-up reference record' } as never })).id)
}, 120000)
afterAll(async () => { await payload?.destroy(); await mongo?.stop() })

describe('datePrecision', () => {
  it('reads how much of a GenBank collection date to trust', () => {
    expect(datePrecision('2019')).toBe('year')
    expect(datePrecision('Mar-2019')).toBe('month')
    expect(datePrecision('2019-03')).toBe('month')
    expect(datePrecision('15-Mar-2019')).toBe('day')
    expect(datePrecision('2019-03-15T10:00')).toBe('day')
    expect(datePrecision('spring 2019')).toBe('unknown')
    expect(datePrecision('')).toBe('unknown')
    expect(datePrecision(undefined)).toBe('unknown')
  })
})

describe('looksLikeCoordinates', () => {
  it('recognizes decimal, hemisphere and degree-minute pairs in free text', () => {
    for (const text of ['UF:Herp:4.61 N 74.08 W Bogota', '4.61N, 74.08W', '4.61° S 74.08° E', 'N 4.61 W 74.08', 'N4.61 W74.08',
      "4°36'35\"N 74°04'54\"W", "4° 36.6' N", '4.6097, -74.0817', 'collected at 4.6097 -74.0817 by hand', '-4.61 N 74.08 W']) {
      expect(looksLikeCoordinates(text), text).toBe(true)
    }
  })
  it('leaves catalog numbers, dates, pages, checksums and ordinary prose alone', () => {
    for (const text of ['Herp:42', 'UF 12345', 'USNM:Herp:4.61', '2019-03-15', 'Vol. 4, pp. 61-74', 'Zootaxa 4612(1): 1-74',
      'Mol. Ecol. 12.5, 13.75', 'a'.repeat(64), 'PQ562694.1', 'release of captive turtles in Colombia. Unpublished', 'N 4 W',
      '1.5 million, 2.25 billion', '', 'version 10.00, 200.00 copies']) {
      expect(looksLikeCoordinates(text), text).toBe(false)
    }
  })
})

describe('genBankToExternalSample', () => {
  const records = parseGenBank(fixture)
  it('maps a real record to an external sample that points at GenBank and keeps no copy', () => {
    const s = genBankToExternalSample(records[0]!) as any
    expect(s).toMatchObject({ origin: 'external', external: { sourceType: 'public-database', database: 'GenBank', accession: 'PQ562694', dataLicense: 'unknown', url: 'https://www.ncbi.nlm.nih.gov/nuccore/PQ562694.1' } })
    expect(s.external.citation).toMatch(/^Arias,L\.A\. From captive to freedom.*in Colombia\. Unpublished$/)
    expect(s.external.citation).not.toMatch(/Direct Submission/)
    // The pointer is the versioned accession, so the record's link lives in `url` alone, under the host's `urlAccess` rule.
    expect(s.rawReads).toEqual([{ pointer: 'PQ562694.1', sha256: `sha256:${sha256Hex(records[0]!.sequence)}`, tier: 'external' }])
    expect(JSON.stringify(s.rawReads)).not.toMatch(/ncbi|http/)
    // The record gives no voucher, collector or date, so none is made up.
    expect(Object.keys(s.external)).not.toContain('voucher')
    expect(Object.keys(s.external)).not.toContain('collector')
    expect(Object.keys(s.external)).not.toContain('collectionDatePrecision')
  })
  it('reads no place qualifier, so no field names a country, locality or coordinate', () => {
    const s = genBankToExternalSample(records[0]!) as any
    expect(Object.keys(s)).toEqual(['origin', 'external', 'rawReads'])
    expect(Object.keys(s.external).filter((k) => /geo|country|local|place|region|lat|lon|coord/i.test(k))).toEqual([])
    // The paper's title names a country, and that is kept as written: the mapper reads the citation, never the place.
    expect(s.external.citation).toContain('Colombia')
  })
  it('leaves out the JOURNAL line when the only reference is the direct submission, because it holds a postal address', () => {
    // EDITED COPY: the first record with its published reference removed, so only the direct submission remains, written
    // in lower case as some submitters do. Core drops the title-case "Direct Submission" itself; this one gets through.
    const onlyDirect = fixture.split(/^\/\/\s*$/m)[0]!.replace(/REFERENCE   1 [\s\S]*?(?=REFERENCE   2)/, '').replace('REFERENCE   2', 'REFERENCE   1').replace('TITLE     Direct Submission', 'TITLE     Direct submission') + '//\n'
    const [rec] = parseGenBank(onlyDirect)
    expect(rec!.references).toHaveLength(1)
    expect(rec!.references[0]!.journal).toMatch(/Submitted/)
    const s = genBankToExternalSample(rec!) as any
    expect(s.external.citation).toBe('Arias,L.A. Direct submission')
    expect(s.external.citation).not.toMatch(/Submitted|Bogota|Cra 30|Colombia/)
  })
})

describe('importGenBank', () => {
  it('saves every record of the fixture as an external sample under the host\'s subject', async () => {
    const seen: string[] = []
    const report = await importGenBank(payload, fixture, { subject: (r) => { seen.push(r.accession); return animal } })
    expect(report.failed).toEqual([])
    expect(report.duplicates).toEqual([])
    expect(report.created.map((c) => c.accession)).toEqual(ACCESSIONS)
    expect(seen).toEqual(ACCESSIONS)
    const docs = await stored()
    expect(docs).toHaveLength(5)
    // The hidden key is the database's backstop, so a second import of the same accessions can't slip past it.
    const keys = await (payload.db as any).collections.samples.find({}).lean()
    expect(keys.map((k: any) => k.external.sourceKey).sort()).toEqual(ACCESSIONS.map((a) => `genbank:${a.toLowerCase()}`).sort())
    for (const d of docs) {
      expect(d).toMatchObject({ origin: 'external', subject: animal, external: { sourceType: 'public-database', database: 'GenBank', dataLicense: 'unknown' } })
      expect(d.rawReads).toHaveLength(1)
      expect(d.rawReads[0]).toMatchObject({ pointer: `${d.external.accession}.1`, tier: 'external', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    }
    // The stored checksum is the record's own sequence checksum.
    const first = docs.find((d) => d.external.accession === 'PQ562694')!
    expect(first.rawReads[0].sha256).toBe(sha256Hex(parseGenBank(fixture)[0]!.sequence))
  })
  it('shows the NCBI link only where urlAccess allows: a reader sees the pointer and no link anywhere', async () => {
    const docs = await readAs(reader)
    expect(docs).toHaveLength(5)
    for (const d of docs) {
      expect(d.rawReads[0].pointer).toMatch(/^PQ56269\d\.1$/)
      expect(d.external).not.toHaveProperty('url')
    }
    expect(JSON.stringify(docs)).not.toMatch(/ncbi\.nlm\.nih\.gov|nuccore|https?:/)
    // With full access the link is there, in `url` alone.
    const full = await stored()
    expect(full[0]!.external.url).toMatch(/^https:\/\/www\.ncbi\.nlm\.nih\.gov\/nuccore\/PQ56269\d\.1$/)
    expect(JSON.stringify(full).match(/nuccore/g)).toHaveLength(5)
  })
  it('does nothing the second time and names the accessions it already holds', async () => {
    const before = (await stored()).map((d) => String(d.id)).sort()
    const again = await importGenBank(payload, fixture, { subject: animal })
    expect(again.created).toEqual([])
    expect(again.failed).toEqual([])
    expect(again.duplicates.map((d) => d.accession)).toEqual(ACCESSIONS)
    expect((await stored()).map((d) => String(d.id)).sort()).toEqual(before)
  })
  it('refuses a cache copy, because GenBank states no license and unknown means pointer only', async () => {
    expect(licenseTerms('unknown').keepCopy).toBe(false)
    await clear()
    const report = await importGenBank(payload, fixture, { subject: animal, tier: 'cache' })
    expect(report.created).toEqual([])
    expect(report.failed).toHaveLength(5)
    expect(report.failed[0]!.reason).toMatch(/license is unknown, so only a pointer may be kept/)
    expect(await stored()).toHaveLength(0)
  })
  it('keeps the voucher, collector and date precision when a record gives them, and never a coordinate', async () => {
    await clear()
    const text = edited('XX000001', ['/lat_lon="4.5 N 74.1 W"', '/specimen_voucher="TEST:Herp:42"', '/collected_by="Made-up Collector"', '/collection_date="Mar-2019"'])
    expect(text).toContain('lat_lon')
    const report = await importGenBank(payload, text, { subject: animal })
    expect(report.failed).toEqual([])
    const [doc] = await stored()
    expect(doc!.external).toMatchObject({ accession: 'XX000001', voucher: { institution: 'TEST', catalogNumber: 'Herp:42' }, collector: 'Made-up Collector', collectionDatePrecision: 'month' })
    const json = JSON.stringify(doc)
    expect(json).not.toMatch(/lat_?lon|4\.5 N|74\.1/i)
  })
  it('refuses a record whose voucher or citation text reads like a coordinate, so nothing of it can be read', async () => {
    await clear()
    const report = await importGenBank(payload, edited('XX000002', ['/specimen_voucher="UF:Herp:4.61 N 74.08 W Bogota"']), { subject: animal })
    expect(report.created).toEqual([])
    expect(report.failed).toEqual([{ accession: 'XX000002', reason: expect.stringMatching(/Samples never hold coordinates, and external\.voucher\.catalogNumber .*reads like one/) }])
    // The same words in a reference title are refused too.
    const inTitle = edited('XX000003', []).replace('From captive to freedom', 'Turtles sampled at 4.61 N 74.08 W')
    const second = await importGenBank(payload, inTitle, { subject: animal })
    expect(second.failed).toEqual([{ accession: 'XX000003', reason: expect.stringMatching(/external\.citation/) }])
    expect(await stored()).toHaveLength(0)
    // A reader finds nothing of either record, and a read with no user is refused outright.
    expect(JSON.stringify(await readAs(reader))).not.toMatch(/4\.61|74\.08|Bogota|XX00000[23]/)
    await expect(anonymousRead()).rejects.toThrow(/not allowed/i)
  })
  it('reports a record the plugin refuses and goes on with the rest', async () => {
    await clear()
    const report = await importGenBank(payload, fixture, { subject: animal, extra: (r) => (r.accession === 'PQ562692' ? { consent: 'yes' } : {}) })
    expect(report.failed).toEqual([{ accession: 'PQ562692', reason: expect.stringMatching(/no keeper consent/) }])
    expect(report.created).toHaveLength(4)
  })
  it('runs under the host\'s access rules when given a request: a user who may not create samples saves nothing', async () => {
    await clear()
    for (const user of [undefined, reader]) {
      const req = await createLocalReq({ user: user as never }, payload)
      const report = await importGenBank(payload, fixture, { subject: animal, req })
      expect(report.created).toEqual([])
      expect(report.duplicates).toEqual([])
      expect(report.failed.map((f) => f.accession)).toEqual(ACCESSIONS)
      for (const f of report.failed) expect(f.reason).toMatch(/not allowed/i)
    }
    expect(await stored()).toHaveLength(0)
    await expect(anonymousRead()).rejects.toThrow(/not allowed/i)
  })
  it('runs under the host\'s access rules when given a request: a curator saves them, and a rerun names the duplicates', async () => {
    const req = await createLocalReq({ user: curator }, payload)
    const report = await importGenBank(payload, fixture, { subject: animal, req })
    expect(report.failed).toEqual([])
    expect(report.created.map((c) => c.accession)).toEqual(ACCESSIONS)
    expect(await stored()).toHaveLength(5)
    const again = await importGenBank(payload, fixture, { subject: animal, req: await createLocalReq({ user: curator }, payload) })
    expect(again.created).toEqual([])
    expect(again.duplicates.map((d) => d.accession)).toEqual(ACCESSIONS)
    // A user who may read but not create gets the five back as refused creates, and sees no id in `duplicates`.
    const asReader = await importGenBank(payload, fixture, { subject: animal, req: await createLocalReq({ user: reader }, payload) })
    expect(asReader.duplicates.map((d) => d.accession)).toEqual(ACCESSIONS)
    expect(asReader.created).toEqual([])
    const anonymous = await importGenBank(payload, fixture, { subject: animal, req: await createLocalReq({}, payload) })
    expect(anonymous.duplicates).toEqual([])
    expect(anonymous.failed).toHaveLength(5)
  })
})
