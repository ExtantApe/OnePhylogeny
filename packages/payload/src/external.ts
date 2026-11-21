import { APIError, type CollectionBeforeChangeHook, type Condition, type Field, type FieldAccess, type Where } from 'payload'

/**
 * Settings for samples that came from outside the host: a paper, a public database, a validated panel or an institution.
 * The plugin knows no roles. Every rule about who sees what is a function the host passes, and each defaults to nobody.
 */
export type ExternalOptions = {
  /**
   * Who may read and change a source's collector name and permit reference. They name people, so the default is nobody:
   * only scripts that bypass access see them. Hosts pass their strictest check here.
   */
  restrictedAccess?: FieldAccess
  /** Who may read the source's own page for a record (`external.url`). Default: nobody. Hosts usually pass their admin check. */
  urlAccess?: FieldAccess
  /** Host collections for the release an import came from and the run that created the sample. Left out, the field isn't added. */
  relations?: { sourceReleases?: string; importRuns?: string }
}

/** One ecoregion set, fixed by version so a stored name can always be traced to the dataset that gave it. */
export type EcoregionPin = { dataset: string; version: string }

/**
 * The ecoregion sets a host uses, one per realm. A pinned realm refuses any value from another dataset or version. An
 * unpinned realm still needs every value to carry its dataset and version.
 */
export type EcoregionOptions = { land?: EcoregionPin; marine?: EcoregionPin; freshwater?: EcoregionPin }

export const ORIGINS = ['internal', 'external'] as const
export const SOURCE_TYPES = ['paper', 'public-database', 'validated-panel', 'institution'] as const
export const DATA_LICENSES = ['cc0', 'cc-by', 'cc-by-nc', 'insdc', 'other', 'unknown'] as const
export const DATE_PRECISIONS = ['day', 'month', 'year', 'unknown'] as const
export const READ_TIERS = ['external', 'cache', 'hot', 'deep-archive'] as const
export const REALMS = ['land', 'marine', 'freshwater'] as const

export type DataLicense = (typeof DATA_LICENSES)[number]

/**
 * What a data license lets a host do with a sequence, read so an unknown or unstated license allows nothing: the record
 * is a pointer to the source, with no copy kept and nothing passed on, until a curator sets a real license. `other`
 * means the terms are written in `dataLicenseNote`, and a person has to read them; the plugin doesn't guess.
 */
export function licenseTerms(license: string | null | undefined): { keepCopy: boolean; redistribute: boolean; commercial: boolean; pointerOnly: boolean } {
  switch (license) {
    case 'cc0': case 'insdc': case 'cc-by': return { keepCopy: true, redistribute: true, commercial: true, pointerOnly: false }
    case 'cc-by-nc': return { keepCopy: true, redistribute: true, commercial: false, pointerOnly: false }
    case 'other': return { keepCopy: true, redistribute: false, commercial: false, pointerOnly: false }
    default: return { keepCopy: false, redistribute: false, commercial: false, pointerOnly: true }
  }
}

const fail = (message: string): never => { throw new APIError(message, 400, undefined, true) }
const nobody: FieldAccess = () => false
const COORDINATES = /^(lat|lon|lng|latitude|longitude|latlon|lat_lon|coordinates?|geometry|point)$/i
const SHA256 = /^[0-9a-f]{64}$/

/** True when a value carries anything: a non-empty string, a number, a date, a related record, or an object with one. */
export const hasValue = (v: unknown): boolean => {
  if (v == null || v === '') return false
  if (Array.isArray(v)) return v.some(hasValue)
  if (typeof v === 'object') return v instanceof Date || Object.values(v as Record<string, unknown>).some(hasValue)
  return true
}

const hasCoordinates = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasCoordinates)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value as Record<string, unknown>).some(([k, v]) => COORDINATES.test(k) || hasCoordinates(v))
}

const whenExternal = { condition: ((data) => data?.origin === 'external') as Condition }
/** Shows a field only on internal samples. */
export const whenInternal: Condition = (data) => data?.origin !== 'external'

const relation = (name: string, relationTo: string | undefined, extra: Partial<Field> = {}): Field[] =>
  relationTo ? [{ name, type: 'relationship', relationTo, index: true, ...extra } as Field] : []

const realm = (name: string, example: string): Field => ({
  name, type: 'group',
  admin: { description: `Set with its dataset and version, for example ${example}. Never a coordinate.` },
  fields: [
    { name: 'code', type: 'text', admin: { description: 'The ecoregion\'s identifier in its dataset.' } },
    { name: 'name', type: 'text' },
    { name: 'dataset', type: 'text' },
    { name: 'version', type: 'text' },
  ],
})

/** The fields added to `samples`: the origin flag, the external source group, raw-read pointers and the ecoregion ceiling. */
export function externalFields(o: ExternalOptions): { origin: Field; external: Field; rawReads: Field; ecoregion: Field } {
  const restricted = o.restrictedAccess ?? nobody
  const url = o.urlAccess ?? nobody
  return {
    origin: {
      name: 'origin', type: 'select', required: true, defaultValue: 'internal', index: true, options: [...ORIGINS],
      admin: { description: 'Internal: the host\'s own material. External: a record from a paper, database, panel or institution. Set once.' },
    },
    external: {
      name: 'external', type: 'group', admin: { ...whenExternal, description: 'Where an external sample came from. Never a keeper\'s data, and never a locality.' },
      fields: [
        { name: 'sourceType', type: 'select', options: [...SOURCE_TYPES] },
        { name: 'accession', type: 'text', index: true, admin: { description: 'The source\'s own identifier, such as a GenBank or ENA accession. Unique with its database.' } },
        { name: 'database', type: 'text', admin: { description: 'The database the accession belongs to, such as GenBank, ENA, BOLD or GBIF. Empty for a paper or institution with no public record.' } },
        { name: 'voucher', type: 'group', fields: [{ name: 'institution', type: 'text', admin: { description: 'The collection\'s code.' } }, { name: 'catalogNumber', type: 'text' }] },
        { name: 'collector', type: 'text', access: { read: restricted, update: restricted }, admin: { description: 'Who collected it, as the source names them. Restricted.' } },
        { name: 'collectionDatePrecision', type: 'select', options: [...DATE_PRECISIONS], admin: { description: 'How much of the collection date to trust. Sources often give a year only.' } },
        { name: 'permit', type: 'text', access: { read: restricted, update: restricted }, admin: { description: 'The permit reference the source gives, as written. Restricted.' } },
        { name: 'dataLicense', type: 'select', options: [...DATA_LICENSES], admin: { description: 'Decides what may be done with the sequence. Unknown means pointer only: no copy kept and nothing passed on.' } },
        { name: 'dataLicenseNote', type: 'text', admin: { description: 'For other: the terms as written, or a link to them.' } },
        { name: 'citation', type: 'text' },
        { name: 'doi', type: 'text' },
        { name: 'url', type: 'text', access: { read: url }, admin: { description: 'The source\'s own page for this record. Shown only where the host allows.' } },
        ...relation('sourceRelease', o.relations?.sourceReleases, { admin: { description: 'The release this sample came in with, when it was imported.' } } as Partial<Field>),
        ...relation('importRun', o.relations?.importRuns, { admin: { description: 'The run that created it, for the audit trail.' } } as Partial<Field>),
      ],
    },
    rawReads: {
      name: 'rawReads', type: 'array', admin: { description: 'Where the raw reads are, never the reads themselves. The host\'s own download rules apply.' },
      fields: [
        { name: 'pointer', type: 'text', required: true, admin: { description: 'An SRA run accession, a URL or the host\'s own storage key.' } },
        { name: 'sha256', type: 'text', required: true, admin: { description: 'Checked whenever the file is fetched.' } },
        { name: 'bytes', type: 'number' },
        { name: 'tier', type: 'select', required: true, options: [...READ_TIERS], admin: { description: 'External: the source holds it, no copy here. Cache: a copy that may be cleared. Hot and deep-archive: the host\'s own reads.' } },
        { name: 'fetchedAt', type: 'date', admin: { description: 'Last time the cache held it.' } },
      ],
    },
    ecoregion: {
      name: 'ecoregion', type: 'group', admin: { description: 'The most any page may show of where a sample came from. Precise localities live in the host\'s own collection, never here.' },
      fields: [
        realm('land', 'RESOLVE Ecoregions 2017'),
        realm('marine', 'Marine Ecoregions of the World 2007'),
        realm('freshwater', 'Freshwater Ecoregions of the World 2008'),
        { name: 'source', type: 'select', options: ['lookup', 'curator', 'source-record'], admin: { description: 'How the ecoregion was found: a lookup from the locality, a curator, or the source record itself.' } },
      ],
    },
  }
}

type Doc = Record<string, unknown>
const group = (doc: Doc | undefined, data: Doc, name: string): Doc => ({ ...((doc?.[name] as Doc | undefined) ?? {}), ...((data[name] as Doc | undefined) ?? {}) })

/**
 * The rules an external or internal sample has to keep, each refused with a plain reason. Works on the record as it will
 * be after the change, so an edit can't slip a field past a rule by leaving the rest of the group alone.
 */
export const sampleRules = (c: { samples: string; hasKit: boolean; ecoregions: EcoregionOptions }): CollectionBeforeChangeHook => async ({ data, originalDoc, operation, req }) => {
  if (hasCoordinates(data)) fail('Samples never hold coordinates. Keep precise localities in your own collection, outside the plugin.')
  const doc = { ...(originalDoc as Doc | undefined), ...data } as Doc
  const origin = String(doc.origin ?? 'internal')
  const external = group(originalDoc, data, 'external')

  if (origin === 'internal') {
    if (hasValue(external)) fail('An internal sample has no external source. Record a sample from a paper, database, panel or institution with origin set to external.')
    if (!hasValue(doc.source)) fail('An internal sample needs how its material arrived: kit, upload or historic.')
  } else {
    if (c.hasKit && hasValue(doc.kit)) fail('An external sample has no kit. Kits are the host\'s own material.')
    if (hasValue(doc.consent)) fail('An external sample has no keeper consent. Its terms are its data license.')
    if (hasValue(doc.source)) fail('An external sample has no source; that field says how the host\'s own material arrived.')
    if (!hasValue(external.sourceType)) fail('An external sample needs its source type: paper, public database, validated panel or institution.')
    // The license fails closed: not stated means unknown, and unknown means pointer only.
    if (!hasValue(external.dataLicense)) { external.dataLicense = 'unknown'; data.external = { ...(data.external as Doc | undefined), dataLicense: 'unknown' } }
    if (hasValue(external.accession) && hasValue(external.database)) {
      const where: Where = { and: [{ 'external.accession': { equals: external.accession } }, { 'external.database': { equals: external.database } }, ...(operation === 'update' && originalDoc?.id != null ? [{ id: { not_equals: originalDoc.id } }] : [])] }
      const taken = await req.payload.find({ collection: c.samples as never, where, limit: 1, depth: 0, overrideAccess: true })
      if (taken.docs.length) fail(`Another sample already records ${external.database} ${external.accession}. Edit that sample instead of adding a second.`)
    }
  }

  const terms = licenseTerms(origin === 'external' ? String(external.dataLicense) : 'cc0')
  for (const read of ((doc.rawReads as Doc[] | undefined) ?? [])) {
    const sha = String(read.sha256 ?? '').replace(/^sha256:/i, '').toLowerCase()
    if (!SHA256.test(sha)) fail(`A raw read's SHA-256 is missing or malformed (${String(read.pointer ?? 'no pointer')}).`)
    read.sha256 = sha
    const tier = String(read.tier)
    if (origin === 'internal' && (tier === 'external' || tier === 'cache')) fail('The host\'s own reads are kept as hot or deep-archive, never as an outside pointer or a cache copy only.')
    if (origin === 'external' && (tier === 'hot' || tier === 'deep-archive')) fail('An external sample\'s reads stay the source\'s: external, or a cache copy that may be cleared.')
    if (origin === 'external' && tier !== 'external' && !terms.keepCopy) fail('This source\'s data license is unknown, so only a pointer may be kept, with no copy, until a curator sets the license.')
  }

  const eco = group(originalDoc, data, 'ecoregion')
  for (const name of REALMS) {
    const value = eco[name] as Doc | undefined
    if (!hasValue(value)) continue
    const pin = c.ecoregions[name]
    if (!hasValue(value!.dataset) || !hasValue(value!.version)) fail(`A ${name} ecoregion needs the dataset and version it came from.`)
    if (pin && (value!.dataset !== pin.dataset || value!.version !== pin.version)) fail(`This site's ${name} ecoregions are ${pin.dataset} ${pin.version}; ${value!.dataset} ${value!.version} isn't that set.`)
  }
  return data
}
