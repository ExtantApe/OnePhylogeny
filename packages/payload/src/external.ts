import { APIError, ValidationError, type CollectionBeforeChangeHook, type Condition, type Config, type Field, type FieldAccess, type Where } from 'payload'

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
 * What a data license lets a host do with a sequence, read so a license the plugin can't decide on allows nothing: the
 * record is a pointer to the source, with no copy kept and nothing passed on, until a curator sets a real license. That
 * covers `unknown`, nothing at all, and `other`: its terms are written in `dataLicenseNote`, which only a person can read,
 * so the plugin answers no. A host that has read them moves the record to a real license.
 */
export function licenseTerms(license: string | null | undefined): { keepCopy: boolean; redistribute: boolean; commercial: boolean; pointerOnly: boolean } {
  switch (license) {
    case 'cc0': case 'insdc': case 'cc-by': return { keepCopy: true, redistribute: true, commercial: true, pointerOnly: false }
    case 'cc-by-nc': return { keepCopy: true, redistribute: true, commercial: false, pointerOnly: false }
    default: return { keepCopy: false, redistribute: false, commercial: false, pointerOnly: true }
  }
}

/** No spaces, lower case, so `GenBank`, ` genbank ` and `Gen Bank` name the same database and `AB 1` is `AB1`. */
const normalize = (v: unknown): string => String(v).replace(/\s+/g, '').toLowerCase()

/**
 * The key the unique index holds for a source record: `database:accession`, both normalized. Accessions are folded to
 * lower case because GenBank, ENA and BOLD read them without regard to case. Undefined when either part is missing, so
 * the sparse index skips samples with no public record.
 */
export const sourceKeyOf = (database: unknown, accession: unknown): string | undefined =>
  hasValue(database) && hasValue(accession) ? `${normalize(database)}:${normalize(accession)}` : undefined

// The plugin's own key only: `external.sourceKey` (or the column spelling `external_source_key`, which Payload reports on
// Postgres) in a validation error, and `external_source_key` in a Postgres constraint such as
// `samples_external_source_key_idx` or a detail line. A host's `resource_key` or `data_source_key` is not ours.
const SOURCE_KEY_PATH = /(^|[._])external[._]source_?key$/i
const SOURCE_KEY_COLUMN = /external_source_key/i
/** The plain refusal for a second sample of one database and accession, shared with the importer. */
export const duplicateMessage = (database: unknown, accession: unknown) => `Another sample already records ${String(database)} ${String(accession)}. Edit that sample instead of adding a second.`
const collidedMessage = (database: unknown, accession: unknown) => `Another write landed in the same instant, most likely a sample with ${String(database)} ${String(accession)}. Try again: if that sample exists, you'll be told so.`

/**
 * A duplicate-key error on the source key, from any adapter. Payload reports MongoDB's as a validation error on the field.
 * Postgres's is SQLSTATE 23505, on the error or somewhere down its `cause` chain (drizzle wraps the driver's error), and
 * the constraint, detail or message names the `external_source_key` column. Another column's unique violation is not ours.
 */
export const isDuplicateKey = (e: unknown): boolean => {
  if (e instanceof ValidationError) return Boolean((e.data as { errors?: { path?: string }[] } | undefined)?.errors?.some((f) => SOURCE_KEY_PATH.test(String(f.path ?? ''))))
  for (let err = e as { code?: unknown; constraint?: unknown; detail?: unknown; message?: unknown; cause?: unknown } | null, depth = 0; err && typeof err === 'object' && depth < 5; err = err.cause as typeof err, depth++) {
    if (err.code === '23505') return [err.constraint, err.detail, err.message].some((v) => SOURCE_KEY_COLUMN.test(String(v ?? '')))
  }
  return false
}
/** MongoDB inside a transaction reports a clash with an uncommitted write as a write conflict, with no key named. */
const isWriteConflict = (e: unknown): boolean => {
  const err = e as { code?: unknown; codeName?: unknown; message?: unknown } | null
  return Boolean(err && typeof err === 'object' && (err.code === 112 || err.codeName === 'WriteConflict' || /WriteConflict|retry your operation/i.test(String(err.message ?? ''))))
}

/**
 * Wraps the host's database adapter so the unique index's own refusal reads like the hook's. The hook's `find` check is
 * the friendly first line; the index is the backstop for two writes in the same instant. Its duplicate-key error (a
 * `ValidationError` on `external.sourceKey`) comes back as the same plain message. Under a MongoDB transaction the
 * second of two concurrent writes sees a write conflict instead, which names no key, so that one says a write collided
 * and names the likely pair; the retry meets the hook's check and gets the exact message. Collection `afterError`
 * hooks only run for REST and GraphQL, so this is the one place a Local API caller gets the same answer.
 */
type Db = NonNullable<Config['db']>
export const withSourceKeyErrors = (db: Db | undefined, samples: string): Db | undefined => {
  if (!db) return db
  const rethrow = (e: unknown, args: { collection?: string; data?: Doc }): never => {
    const ext = args.data?.external as Doc | undefined
    if (args.collection !== samples || !hasValue(ext?.sourceKey)) throw e
    if (isDuplicateKey(e)) throw new APIError(duplicateMessage(ext?.database, ext?.accession), 400, undefined, true)
    if (isWriteConflict(e)) throw new APIError(collidedMessage(ext?.database, ext?.accession), 409, undefined, true)
    throw e
  }
  return {
    ...db,
    init: (args: Parameters<Db['init']>[0]) => {
      const adapter = db.init(args) as unknown as Record<string, unknown>
      for (const op of ['create', 'updateOne', 'upsert']) {
        const original = adapter[op]
        if (typeof original !== 'function') continue
        adapter[op] = async (a: { collection?: string; data?: Doc }) => {
          try { return await (original as (this: unknown, a: unknown) => Promise<unknown>).call(adapter, a) } catch (e) { return rethrow(e, a) }
        }
      }
      return adapter as unknown as ReturnType<Db['init']>
    },
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

// A degree value with an optional sign and decimals, as it appears in text: 4.61, -74.08, 4, 74.0817.
const DEG = String.raw`-?\d{1,3}(?:\.\d+)?`
const COORDINATE_TEXT = [
  // Decimal degrees with hemispheres: 4.61 N 74.08 W, 4.61N, 74.08W, 4.61° S, 74.08° E.
  new RegExp(String.raw`(?<![\w.])${DEG}\s*[°º]?\s*[NS]\b[\s,;/]*${DEG}\s*[°º]?\s*[EW]\b`, 'i'),
  // Hemisphere first: N 4.61 W 74.08, N4.61, W74.08.
  new RegExp(String.raw`\b[NS]\s*${DEG}\s*[°º]?[\s,;/]*[EW]\s*${DEG}(?![\w.])`, 'i'),
  // Degrees and minutes, with or without seconds, and a hemisphere: 4°36'35"N, 74° 04.9' W.
  new RegExp(String.raw`\d{1,3}\s*[°º]\s*\d{1,2}(?:\.\d+)?\s*['′’]\s*(?:\d{1,2}(?:\.\d+)?\s*["″”]\s*)?[NSEW]\b`, 'i'),
]
// A plain decimal pair with at least two decimals each (4.6097, -74.0817 or 4.6097 -74.0817), checked for range below.
const DECIMAL_PAIR = /(?<![\w.-])(-?\d{1,2}\.\d{2,})(?:\s*,\s*|\s+)(-?\d{1,3}\.\d{2,})(?![\w.])/

/**
 * True when free text reads like a coordinate: a decimal or degree-minute pair with hemisphere letters, or a plain
 * decimal pair in the range of a latitude and longitude. A catalog number, a date, a page range or a checksum is not one.
 * Tight on purpose: it refuses what is plainly a position, so a sample's text can't carry a locality past the field
 * names, and leaves ordinary numbers alone.
 */
export const looksLikeCoordinates = (text: string): boolean => {
  if (COORDINATE_TEXT.some((re) => re.test(text))) return true
  const pair = DECIMAL_PAIR.exec(text)
  return pair !== null && Math.abs(Number(pair[1])) <= 90 && Math.abs(Number(pair[2])) <= 180
}

/** The path of the first field that holds a coordinate, by its name or by text that reads like one, or undefined. */
const findCoordinate = (value: unknown, path = ''): string | undefined => {
  if (typeof value === 'string') return looksLikeCoordinates(value) ? path : undefined
  if (Array.isArray(value)) { for (const [i, v] of value.entries()) { const hit = findCoordinate(v, `${path}[${i}]`); if (hit !== undefined) return hit } return undefined }
  if (!value || typeof value !== 'object' || value instanceof Date) return undefined
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const at = path ? `${path}.${k}` : k
    if (COORDINATES.test(k)) return at
    const hit = findCoordinate(v, at)
    if (hit !== undefined) return hit
  }
  return undefined
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
        { name: 'accession', type: 'text', index: true, admin: { description: 'The source\'s own identifier, such as a GenBank or ENA accession. Unique with its database, without regard to case or spacing.' } },
        { name: 'database', type: 'text', admin: { description: 'The database the accession belongs to, such as GenBank, ENA, BOLD or GBIF. Empty for a paper or institution with no public record.' } },
        // Filled by the hook, never by hand. Not required, so the adapters give it a sparse unique index that skips samples with no public record.
        { name: 'sourceKey', type: 'text', unique: true, hidden: true, admin: { readOnly: true, hidden: true } },
        { name: 'voucher', type: 'group', fields: [{ name: 'institution', type: 'text', admin: { description: 'The collection\'s code.' } }, { name: 'catalogNumber', type: 'text' }] },
        { name: 'collector', type: 'text', access: { read: restricted, update: restricted }, admin: { description: 'Who collected it, as the source names them. Restricted.' } },
        { name: 'collectionDatePrecision', type: 'select', options: [...DATE_PRECISIONS], admin: { description: 'How much of the collection date to trust. Sources often give a year only.' } },
        { name: 'permit', type: 'text', access: { read: restricted, update: restricted }, admin: { description: 'The permit reference the source gives, as written. Restricted.' } },
        { name: 'dataLicense', type: 'select', options: [...DATA_LICENSES], admin: { description: 'Decides what may be done with the sequence. Unknown and other mean pointer only: no copy kept and nothing passed on, until a curator who has read the terms sets a real license.' } },
        { name: 'dataLicenseNote', type: 'text', admin: { description: 'For other: the terms as written, or a link to them, for a person to read.' } },
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
  const coordinate = findCoordinate(data)
  if (coordinate !== undefined) fail(`Samples never hold coordinates, and ${coordinate || 'this sample'} holds one or reads like one. Keep precise localities in your own collection, outside the plugin.`)
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
    // The key is the plugin's, computed from the record as it will be, so a value sent by a client is replaced, and a
    // cleared accession takes the key with it. The key is left out rather than set to null, because a sparse index still indexes an explicit null.
    const key = sourceKeyOf(external.database, external.accession)
    const sent = { ...(data.external as Doc | undefined) }
    delete sent.sourceKey
    // Mongo drops an omitted key from the group. Postgres keeps the old column value, so a cleared accession must set it to NULL there.
    const hadKey = operation === 'update' && hasValue((originalDoc?.external as Doc | undefined)?.sourceKey)
    data.external = key ? { ...sent, sourceKey: key } : hadKey && req.payload.db.name !== 'mongoose' ? { ...sent, sourceKey: null } : sent
    if (key) {
      const where: Where = { and: [{ 'external.sourceKey': { equals: key } }, ...(operation === 'update' && originalDoc?.id != null ? [{ id: { not_equals: originalDoc.id } }] : [])] }
      const taken = await req.payload.find({ collection: c.samples as never, where, limit: 1, depth: 0, overrideAccess: true })
      if (taken.docs.length) fail(duplicateMessage(external.database, external.accession))
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
