import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { parseGenBank, sha256Hex } from '@extantape/onephylogeny-core'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { readFileSync } from 'node:fs'
import { buildConfig, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { datePrecision, genBankToExternalSample, importGenBank, licenseTerms } from '../src/index.js'

// Five real public GenBank records (see fixtures/external/README.md). Nothing here is from Captive Origins.
const fixture = readFileSync(new URL('../../../fixtures/external/cytb-chelonoidis-carbonarius.gb', import.meta.url), 'utf8')
const ACCESSIONS = ['PQ562694', 'PQ562693', 'PQ562692', 'PQ562691', 'PQ562690']

let payload: Payload
let mongo: MongoMemoryReplSet
let animal: string
const stored = async () => (await payload.find({ collection: 'samples' as never, limit: 100, depth: 0, pagination: false })).docs as unknown as Record<string, any>[]
const clear = async () => { await payload.delete({ collection: 'samples' as never, where: { id: { exists: true } } as never }) }

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  payload = await getPayload({ config: await buildConfig({
    secret: 'test-secret-not-for-production', telemetry: false, typescript: { autoGenerate: false },
    db: mongooseAdapter({ url: mongo.getUri('import'), ensureIndexes: true }),
    collections: [{ slug: 'animals', fields: [{ name: 'name', type: 'text' }] }],
    plugins: [onePhylogenyPlugin()],
  }) })
  animal = String((await payload.create({ collection: 'animals' as never, data: { name: 'Made-up reference record' } as never })).id)
}, 120000)
afterAll(async () => { await payload?.destroy(); await mongo?.stop() })

import { onePhylogeny } from '../src/index.js'
function onePhylogenyPlugin() { return onePhylogeny({ relations: { subject: 'animals' }, records: { external: {} } }) }

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

describe('genBankToExternalSample', () => {
  const records = parseGenBank(fixture)
  it('maps a real record to an external sample that points at GenBank and keeps no copy', () => {
    const s = genBankToExternalSample(records[0]!) as any
    expect(s).toMatchObject({ origin: 'external', external: { sourceType: 'public-database', database: 'GenBank', accession: 'PQ562694', dataLicense: 'unknown', url: 'https://www.ncbi.nlm.nih.gov/nuccore/PQ562694.1' } })
    expect(s.external.citation).toMatch(/^Arias,L\.A\. From captive to freedom.*in Colombia\. Unpublished$/)
    expect(s.external.citation).not.toMatch(/Direct Submission/)
    expect(s.rawReads).toEqual([{ pointer: 'https://www.ncbi.nlm.nih.gov/nuccore/PQ562694.1', sha256: `sha256:${sha256Hex(records[0]!.sequence)}`, tier: 'external' }])
    // The record gives no voucher, collector or date, so none is made up.
    expect(Object.keys(s.external)).not.toContain('voucher')
    expect(Object.keys(s.external)).not.toContain('collector')
    expect(Object.keys(s.external)).not.toContain('collectionDatePrecision')
  })
  it('keeps no place field at all, not even the country the record names', () => {
    const s = genBankToExternalSample(records[0]!) as any
    expect(Object.keys(s)).toEqual(['origin', 'external', 'rawReads'])
    expect(Object.keys(s.external).filter((k) => /geo|country|local|place|region|lat|lon|coord/i.test(k))).toEqual([])
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
      expect(d.rawReads[0]).toMatchObject({ tier: 'external', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    }
    // The stored checksum is the record's own sequence checksum.
    const first = docs.find((d) => d.external.accession === 'PQ562694')!
    expect(first.rawReads[0].sha256).toBe(sha256Hex(parseGenBank(fixture)[0]!.sequence))
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
    // EDITED COPY, not a real record: the first fixture record with a made-up accession, voucher, collector, date and lat_lon.
    const edited = fixture.split(/^\/\/\s*$/m)[0]!.replace(/PQ562694/g, 'XX000001')
      .replace('/geo_loc_name="Colombia"', '/geo_loc_name="Colombia"\n                     /lat_lon="4.5 N 74.1 W"\n                     /specimen_voucher="TEST:Herp:42"\n                     /collected_by="Made-up Collector"\n                     /collection_date="Mar-2019"') + '//\n'
    expect(edited).toContain('lat_lon')
    const report = await importGenBank(payload, edited, { subject: animal })
    expect(report.failed).toEqual([])
    const [doc] = await stored()
    expect(doc!.external).toMatchObject({ accession: 'XX000001', voucher: { institution: 'TEST', catalogNumber: 'Herp:42' }, collector: 'Made-up Collector', collectionDatePrecision: 'month' })
    const json = JSON.stringify(doc)
    expect(json).not.toMatch(/lat_?lon|4\.5 N|74\.1/i)
  })
  it('reports a record the plugin refuses and goes on with the rest', async () => {
    await clear()
    const report = await importGenBank(payload, fixture, { subject: animal, extra: (r) => (r.accession === 'PQ562692' ? { consent: 'yes' } : {}) })
    expect(report.failed).toEqual([{ accession: 'PQ562692', reason: expect.stringMatching(/no keeper consent/) }])
    expect(report.created).toHaveLength(4)
  })
})
