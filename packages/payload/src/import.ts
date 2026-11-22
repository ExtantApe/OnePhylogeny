import { parseGenBank, toSequenceRecord, type GenBankRecord } from '@extantape/onephylogeny-core'
import type { Payload } from 'payload'
import { sourceKeyOf } from './external.js'

type Doc = Record<string, unknown>
const MONTHS = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)$/i

/**
 * How much of a GenBank `collection_date` to trust, from its shape alone: `2019`, `Mar-2019` or `2019-03`, `15-Mar-2019`
 * or `2019-03-15`, with a trailing time or range ignored. The date itself isn't kept. Anything else is `unknown`.
 */
export function datePrecision(value: string | undefined): 'day' | 'month' | 'year' | 'unknown' {
  const v = (value ?? '').trim().split(/[T/\s]/)[0] ?? ''
  if (/^\d{4}$/.test(v)) return 'year'
  if (/^\d{4}-\d{2}$/.test(v) || (/^[A-Za-z]{3}-\d{4}$/.test(v) && MONTHS.test(v.slice(0, 3)))) return 'month'
  if (/^\d{4}-\d{2}-\d{2}$/.test(v) || (/^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(v) && MONTHS.test(v.split('-')[1]!))) return 'day'
  return 'unknown'
}

/** `USNM:Herp:12345` is institution `USNM` and number `Herp:12345`; `UF 1234` is `UF` and `1234`; a lone token is a number. */
function splitVoucher(v: string): { institution?: string; catalogNumber: string } {
  const at = v.search(/[:\s]/)
  return at > 0 ? { institution: v.slice(0, at), catalogNumber: v.slice(at + 1).trim() } : { catalogNumber: v }
}

export type GenBankImportOptions = {
  /**
   * The host's subject (the `samples.subject` relation) for a record. The plugin requires one, and what a reference
   * record stands for is the host's call, so the import never makes one up. A plain id is used for every record.
   */
  subject: string | number | ((record: GenBankRecord) => string | number | Promise<string | number>)
  /** Anything else the host's `samples` needs, such as its tenant field. Merged over the mapped fields. */
  extra?: (record: GenBankRecord) => Doc
  /**
   * Where a copy of the sequence may be kept: `external` (the default) points at GenBank and keeps nothing, `cache` keeps
   * a copy. GenBank states no license, so the record is `unknown`, and the plugin refuses `cache` for it.
   */
  tier?: 'external' | 'cache'
  /** The collection's slug. Default `samples`. */
  samples?: string
}

/**
 * Turns one parsed GenBank record into the input for an external sample: GenBank as a public database, the accession
 * without its version (so a new version of the record is the same sample), the voucher, collector and the precision of
 * the collection date where the record gives them, the first reference that isn't the direct submission as the
 * citation, a link to the record, and a `rawReads` pointer to it checked by the sequence's own SHA-256.
 *
 * The record states no data license, so it is `unknown`: pointer only. Nothing about where it was collected is kept.
 * `lat_lon` and the free-text locality are never read, and the plugin refuses a coordinate in any case. Pure: it makes
 * no request and touches no database.
 */
export function genBankToExternalSample(rec: GenBankRecord, o: { tier?: 'external' | 'cache' } = {}): Doc {
  const source = rec.features.find((f) => f.key === 'source')?.qualifiers ?? {}
  const flat = toSequenceRecord(rec)
  const ref = rec.references.find((r) => r.title && !/^direct submission$/i.test(r.title.trim())) ?? rec.references[0]
  const citation = ref ? [ref.authors, ref.title, ref.journal].filter(Boolean).map((v) => String(v).replace(/\.$/, '')).join('. ') : undefined
  const collectedBy = source.collected_by?.[0]
  const precision = source.collection_date?.[0] ? datePrecision(source.collection_date[0]) : undefined
  const url = `https://www.ncbi.nlm.nih.gov/nuccore/${encodeURIComponent(rec.version || rec.accession)}`
  const external: Doc = {
    sourceType: 'public-database',
    database: 'GenBank',
    accession: rec.accession,
    dataLicense: 'unknown',
    url,
    ...(source.specimen_voucher?.[0] ? { voucher: splitVoucher(source.specimen_voucher[0]) } : {}),
    ...(collectedBy ? { collector: collectedBy } : {}),
    ...(precision ? { collectionDatePrecision: precision } : {}),
    ...(citation ? { citation } : {}),
  }
  return {
    origin: 'external',
    external,
    rawReads: [{ pointer: url, sha256: flat.sequenceSha256, tier: o.tier ?? 'external' }],
  }
}

export type GenBankImportReport = {
  /** Accessions saved, with the new sample's id. */
  created: { accession: string; id: string | number }[]
  /** Accessions a sample already holds, so nothing was added. */
  duplicates: { accession: string; id: string | number }[]
  /** Records the plugin refused, in its words. */
  failed: { accession: string; reason: string }[]
}

/**
 * Imports a GenBank flat file as external samples through the Local API, so every rule of the plugin applies. Safe to
 * run twice: an accession a sample already holds is reported as a duplicate. One refused record doesn't stop the rest.
 */
export async function importGenBank(payload: Payload, text: string, o: GenBankImportOptions): Promise<GenBankImportReport> {
  const collection = (o.samples ?? 'samples') as never
  const report: GenBankImportReport = { created: [], duplicates: [], failed: [] }
  const existing = async (accession: string) => {
    const where = { 'external.sourceKey': { equals: sourceKeyOf('GenBank', accession) } }
    return (await payload.find({ collection, where: where as never, limit: 1, depth: 0, overrideAccess: true })).docs[0] as { id: string | number } | undefined
  }
  for (const rec of parseGenBank(text)) {
    const found = await existing(rec.accession)
    if (found) { report.duplicates.push({ accession: rec.accession, id: found.id }); continue }
    try {
      const subject = typeof o.subject === 'function' ? await o.subject(rec) : o.subject
      const data = { ...genBankToExternalSample(rec, { tier: o.tier }), subject, ...(o.extra?.(rec) ?? {}) }
      const made = await payload.create({ collection, data: data as never, depth: 0 })
      report.created.push({ accession: rec.accession, id: made.id as string | number })
    } catch (e) {
      // Two imports at once: the other one won, and that's a duplicate here.
      const raced = await existing(rec.accession)
      if (raced) report.duplicates.push({ accession: rec.accession, id: raced.id })
      else report.failed.push({ accession: rec.accession, reason: e instanceof Error ? e.message : String(e) })
    }
  }
  return report
}
