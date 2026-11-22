import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

/**
 * A throwaway Postgres for the tests, or the one the caller points at.
 * With ONEPHYLOGENY_TEST_POSTGRES_URL set, that database is used as is and nothing is started or removed.
 * With ONEPHYLOGENY_TEST_DOCKER=1, one postgres:17-alpine container is started on a random port of 127.0.0.1 and removed
 * by `stop`. Without either, `available` is false and the Postgres tests skip.
 */
export const postgresRoute = process.env.ONEPHYLOGENY_TEST_POSTGRES_URL ? 'url' : process.env.ONEPHYLOGENY_TEST_DOCKER === '1' ? 'docker' : 'none'

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

export type Postgres = { url: string; stop: () => void }

export async function startPostgres(): Promise<Postgres> {
  if (postgresRoute === 'url') return { url: process.env.ONEPHYLOGENY_TEST_POSTGRES_URL!, stop: () => {} }
  const name = `onephylogeny-test-pg-${randomBytes(4).toString('hex')}`
  const password = randomBytes(8).toString('hex')
  const stop = () => { try { docker('rm', '-f', name) } catch { /* already gone */ } }
  try {
    docker('run', '-d', '--rm', '--name', name, '-e', `POSTGRES_PASSWORD=${password}`, '-p', '127.0.0.1::5432', 'postgres:17-alpine')
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
