import type { Field } from 'payload'
import { describe, expect, it } from 'vitest'
import { recordCollections } from '../src/records.js'

// The admin shows fields by origin. These are plain functions of the form's data, so they are checked without an admin.
describe('admin conditions on samples', () => {
  const { collections } = recordCollections({ relations: { kit: 'kits' } }, { panels: 'panels', assignments: 'assignments', subject: 'animals', manage: () => true, againstShown: false })
  const fields = collections.find((c) => c.slug === 'samples')!.fields as (Field & { name: string; admin?: { condition?: (data: Record<string, unknown>, sibling: Record<string, unknown>, ctx: never) => boolean } })[]
  const shown = (name: string, data: Record<string, unknown>) => {
    const condition = fields.find((f) => f.name === name)?.admin?.condition
    return condition ? condition(data, {}, {} as never) : true
  }

  it('show kit, source and consent on internal samples only, and a new form counts as internal', () => {
    for (const name of ['kit', 'source', 'consent']) {
      expect(shown(name, { origin: 'internal' })).toBe(true)
      expect(shown(name, {})).toBe(true)
      expect(shown(name, { origin: 'external' })).toBe(false)
    }
  })
  it('show the external group on external samples only', () => {
    expect(shown('external', { origin: 'external' })).toBe(true)
    expect(shown('external', { origin: 'internal' })).toBe(false)
    expect(shown('external', {})).toBe(false)
  })
  it('leave origin, raw reads and ecoregion visible for both', () => {
    for (const name of ['origin', 'rawReads', 'ecoregion']) expect(shown(name, { origin: 'internal' }) && shown(name, { origin: 'external' })).toBe(true)
  })
})
