import { postgresAdapter } from '@payloadcms/db-postgres'
import { buildConfig, getPayload, ValidationError, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { onePhylogeny } from '../src/index.js'
import { isDuplicateKey } from '../src/external.js'
import { assertEmptyDatabase, postgresRoute, startPostgres, type Postgres } from './support/postgres.js'

// Run against a real Postgres with ONEPHYLOGENY_TEST_DOCKER=1 (starts and removes its own container) or
// ONEPHYLOGENY_TEST_POSTGRES_URL=postgres://... (an empty throwaway database; one that already holds tables is refused,
// because the tests push the schema into it). Otherwise these skip.
const real = postgresRoute === 'none' ? describe.skip : describe

describe('duplicate-key recognition (no database)', () => {
  const on = (over: Record<string, unknown>) => Object.assign(new Error('duplicate key value violates unique constraint "samples_external_source_key_idx"'), over)
  it('reads SQLSTATE 23505 on the error, or under its cause, when the constraint names the source key', () => {
    expect(isDuplicateKey(on({ code: '23505', constraint: 'samples_external_source_key_idx' }))).toBe(true)
    expect(isDuplicateKey(Object.assign(new Error('Failed query'), { cause: on({ code: '23505', constraint: 'samples_external_source_key_idx' }) }))).toBe(true)
    expect(isDuplicateKey(Object.assign(new Error('Failed query'), { cause: Object.assign(new Error('x'), { cause: on({ code: '23505', constraint: 'samples_external_source_key_idx' }) }) }))).toBe(true)
  })
  it('does not call another unique violation, or another error, a duplicate accession', () => {
    expect(isDuplicateKey(on({ code: '23505', constraint: 'users_email_idx', message: 'duplicate key value violates unique constraint "users_email_idx"' }))).toBe(false)
    expect(isDuplicateKey(on({ code: '23503', constraint: 'samples_external_source_key_idx' }))).toBe(false)
    expect(isDuplicateKey(new Error('boom'))).toBe(false)
    expect(isDuplicateKey(null)).toBe(false)
    expect(isDuplicateKey(Object.assign(new Error('Failed query'), { cause: undefined }))).toBe(false)
  })
  it('does not take a host column that merely ends in source_key for the plugin\'s own', () => {
    for (const column of ['resource_key', 'data_source_key', 'source_key', 'sourceKey']) {
      expect(isDuplicateKey(on({ code: '23505', constraint: `things_${column}_idx`, detail: `Key (${column})=(x) already exists.`, message: `duplicate key value violates unique constraint "things_${column}_idx"` })), column).toBe(false)
    }
    expect(isDuplicateKey(on({ code: '23505', constraint: undefined, detail: 'Key (external_source_key)=(genbank:x) already exists.' }))).toBe(true)
    expect(isDuplicateKey(new ValidationError({ errors: [{ message: 'Value must be unique', path: 'resource.sourceKey' }] }))).toBe(false)
    expect(isDuplicateKey(new ValidationError({ errors: [{ message: 'Value must be unique', path: 'sourceKey' }] }))).toBe(false)
    expect(isDuplicateKey(new ValidationError({ errors: [{ message: 'Value must be unique', path: 'external_source_key' }] }))).toBe(true)
  })
  it('keeps recognizing the validation error Payload makes from a duplicate key', () => {
    expect(isDuplicateKey(new ValidationError({ errors: [{ message: 'Value must be unique', path: 'external.sourceKey' }] }))).toBe(true)
    expect(isDuplicateKey(new ValidationError({ errors: [{ message: 'Value must be unique', path: 'email' }] }))).toBe(false)
  })
})

real('accession uniqueness on Postgres', () => {
  let payload: Payload
  let pg: Postgres
  let animal: string | number
  const create = (external?: Record<string, unknown>) => payload.create({ collection: 'samples' as never, depth: 0, data: { subject: animal, origin: 'external', external: { sourceType: 'public-database', ...external } } as never }) as Promise<Record<string, unknown>>
  const update = (id: unknown, data: Record<string, unknown>) => payload.update({ collection: 'samples' as never, id: id as never, data: data as never })
  const rows = async (sql: string, params: unknown[] = []) => ((payload.db as unknown as { pool: { query: (s: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> } }).pool.query(sql, params)).then((r) => r.rows)
  const count = async (key: string) => Number((await rows('select count(*)::int as n from samples where external_source_key = $1', [key]))[0]!.n)

  beforeAll(async () => {
    pg = await startPostgres()
    payload = await getPayload({ config: await buildConfig({
      secret: 'test-secret-not-for-production', telemetry: false, typescript: { autoGenerate: false },
      db: postgresAdapter({ pool: { connectionString: pg.url }, push: true }),
      collections: [{ slug: 'animals', fields: [{ name: 'name', type: 'text' }] }],
      plugins: [onePhylogeny({ relations: { subject: 'animals' }, records: { external: {} } })],
    }) })
    animal = (await payload.create({ collection: 'animals' as never, data: { name: 'Made-up reference tortoise' } as never })).id as string | number
  }, 180000)
  afterAll(async () => {
    // Payload's pool keeps one connection checked out, so `pool.end()` never finishes. Give it a moment, then let the
    // remaining connections ignore the shutdown, so stopping the database isn't reported as an uncaught error.
    try {
      await payload?.destroy()
      const pool = (payload?.db as unknown as { pool?: { end: () => Promise<void>; _clients?: { on: (e: string, f: () => void) => void }[] } } | undefined)?.pool
      await Promise.race([pool?.end().catch(() => {}), new Promise((r) => setTimeout(r, 2000))])
      for (const client of pool?._clients ?? []) client.on('error', () => {})
    } finally { pg?.stop() }
  }, 60000)

  it('saves many external samples that have no accession, each with a NULL key', async () => {
    for (let i = 0; i < 4; i++) await create({ citation: `Made-up paper ${i}` })
    await create({ database: 'GenBank' })
    await create({ accession: 'ONLYACC1' })
    const nulls = await rows('select count(*)::int as n from samples where external_source_key is null and origin = $1', ['external'])
    expect(Number(nulls[0]!.n)).toBeGreaterThanOrEqual(6)
    expect(await rows("select 1 from samples where external_source_key = ''")).toHaveLength(0)
  })
  it('refuses the same database and accession in plain words, whatever the case or spacing', async () => {
    await create({ database: 'GenBank', accession: 'PG000001' })
    await expect(create({ database: 'GenBank', accession: 'PG000001' })).rejects.toThrow(/Another sample already records GenBank PG000001/)
    await expect(create({ database: ' gen bank ', accession: 'pg000001' })).rejects.toThrow(/already records/)
    await expect(create({ database: 'ENA', accession: 'PG000001' })).resolves.toBeTruthy()
    expect(await count('genbank:pg000001')).toBe(1)
  })
  it('has the index refuse a write the hook did not see, in the same words', async () => {
    const a = await create({ database: 'GenBank', accession: 'PG000002' })
    // Hide the first sample from the hook's lookup by writing through the adapter with the hook's check bypassed: a second
    // sample is made with no key, then given the key by a direct update that skips hooks.
    const b = await create({ database: 'GenBank', accession: 'PG000003' })
    await expect(payload.db.updateOne({ collection: 'samples', id: b.id as never, data: { external: { database: 'GenBank', accession: 'PG000002', sourceKey: 'genbank:pg000002' } } as never, req: { payload } as never })).rejects.toThrow(/Another sample already records GenBank PG000002/)
    expect(a.id).not.toBe(b.id)
  })
  it('leaves exactly one sample when many creates of the same pair arrive together', async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => create({ database: 'GenBank', accession: 'PG000004' })))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    for (const r of results) if (r.status === 'rejected') expect(String(r.reason?.message)).toMatch(/already records GenBank PG000004|Try again/)
    expect(await count('genbank:pg000004')).toBe(1)
  })
  it('frees the key when the accession is cleared, and a second sample can then take it', async () => {
    const first = await create({ database: 'GenBank', accession: 'PG000005' })
    await update(first.id, { external: { accession: '' } })
    expect(await count('genbank:pg000005')).toBe(0)
    expect((await rows('select external_source_key as k from samples where id = $1', [first.id]))[0]!.k).toBeNull()
    await expect(create({ database: 'GenBank', accession: 'PG000005' })).resolves.toBeTruthy()
  })
  it('would refuse this database, now that it holds tables, if it were handed over by URL', async () => {
    await expect(assertEmptyDatabase(pg.url)).rejects.toThrow(/already holds \d+ table/)
  })
})
