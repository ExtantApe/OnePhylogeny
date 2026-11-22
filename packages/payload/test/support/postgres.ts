import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import pg from 'pg'

/**
 * A throwaway Postgres for the tests, or the one the caller points at.
 * With ONEPHYLOGENY_TEST_POSTGRES_URL set, that database is used as is and nothing is started or removed. The tests run
 * `push: true` against it, so it must be an empty throwaway database: one that already holds a table is refused.
 * With ONEPHYLOGENY_TEST_DOCKER=1, one Postgres 17 container (the image pinned by digest below) is started on a random
 * port of 127.0.0.1 and removed by `stop`. A run that is killed before `stop` leaves that container behind: remove it by
 * hand (`docker rm -f onephylogeny-test-pg-<id>`). Without either, `available` is false and the Postgres tests skip.
 */
export const postgresRoute = process.env.ONEPHYLOGENY_TEST_POSTGRES_URL ? 'url' : process.env.ONEPHYLOGENY_TEST_DOCKER === '1' ? 'docker' : 'none'

// postgres:17-alpine, the multi-architecture index as published on 2026-11-18. Pinned so a run can't pull a changed image.
const IMAGE = 'postgres:17-alpine@sha256:f9cf3e1f0066f0eb0c48707d864f0ac5941e9ff454a072077d97a4d278d07d73'

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

export type Postgres = { url: string; stop: () => void }

/** Refuses a database that already holds a table in its current schema, because the tests push the schema into it. */
export async function assertEmptyDatabase(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    const { rows } = await client.query<{ n: number }>("select count(*)::int as n from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE'")
    const n = rows[0]?.n ?? 0
    if (n > 0) throw new Error(`ONEPHYLOGENY_TEST_POSTGRES_URL points at a database that already holds ${n} table(s). The tests push a schema into it, so give them an empty throwaway database.`)
  } finally { await client.end() }
}

export async function startPostgres(): Promise<Postgres> {
  if (postgresRoute === 'url') {
    const url = process.env.ONEPHYLOGENY_TEST_POSTGRES_URL!
    await assertEmptyDatabase(url)
    return { url, stop: () => {} }
  }
  const name = `onephylogeny-test-pg-${randomBytes(4).toString('hex')}`
  const password = randomBytes(8).toString('hex')
  const stop = () => { try { docker('rm', '-f', name) } catch { /* already gone */ } }
  try {
    docker('run', '-d', '--rm', '--name', name, '-e', `POSTGRES_PASSWORD=${password}`, '-p', '127.0.0.1::5432', IMAGE)
    const port = docker('port', name, '5432/tcp').split('\n')[0]!.split(':').pop()
    // The image starts a temporary server to initialize, stops it, then starts the real one, so wait for the second "ready" line.
    for (let i = 0; ; i++) {
      if (i > 120) throw new Error('Postgres did not become ready in 60 seconds.')
      const out = spawnSync('docker', ['logs', name], { encoding: 'utf8' })
      const log = `${out.stdout}${out.stderr}`
      if ((log.match(/ready to accept connections/g) ?? []).length >= 2) break
      await new Promise((r) => setTimeout(r, 500))
    }
    return { url: `postgres://postgres:${password}@127.0.0.1:${port}/postgres`, stop }
  } catch (e) { stop(); throw e }
}
