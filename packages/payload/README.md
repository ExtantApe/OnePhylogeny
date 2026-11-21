# @extantape/payload-plugin-onephylogeny

OnePhylogeny for Payload: immutable reference panels and released results on your own collections, with server-enforced review, safe endpoints and no coordinates.

See the [repository](https://github.com/ExtantApe/OnePhylogeny) for documentation.

## Samples and sequences

Pass `records` to add `samples` and `sequences`. A lab's file becomes one of each through one call:

```ts
import { registerSequence } from '@extantape/payload-plugin-onephylogeny'

const { sample, sequence, created } = await registerSequence(payload, {
  tenant, animal, kit, lab, file, // your own record IDs; taxon is read from the animal if you leave it out
  sha256,                          // computed by your server from the stored bytes
  text,                            // the file's contents, which must hash to sha256
  marker: 'cytb',
})
```

It refuses, in plain words, a file whose text doesn't match its SHA-256, a file with more or fewer than one sequence, characters that aren't DNA bases, a sequence outside the lengths set for its marker, and an animal with no species. Sending the same file for the same kit again changes nothing (`created: false`). It writes with full access, so check first that the caller may submit results for that kit.

A Sanger chromatogram goes in the same way, with its bytes instead of text:

```ts
import { registerTrace } from '@extantape/payload-plugin-onephylogeny'

const { sequence } = await registerTrace(payload, { tenant, animal, kit, lab, file, sha256, bytes, fileName: 'K0001-F.ab1', marker: 'cytb' })
```

The read is trimmed by quality and bases below Q20 become N (OnePhylogeny's `assessRead`, with its stated defaults). The kept bases are stored and tested like any sequence. The sequence's `trace` field records how the read was judged: status, kept range, raw length, mean quality, masked bases and mixed-peak count. Nothing else from the file is stored. A file that isn't a chromatogram, doesn't match its SHA-256, or holds a failed or too-short read (under 100 good bases) is refused, and nothing is stored. Joining a forward and a reverse read isn't offered here yet; send the better read.

`assignWaiting(payload, { evaluate })` is the sweep. It tests each waiting sequence against the panel for its marker and species, using the `evaluate` function you pass (OnePhylogeny's `testSample` in a Node job), and records a result pending review. A sequence with no panel stays waiting, and one the panel's checks refuse is marked `not-assessable`, with the reason. Results reach readers only after a reviewer approves them.

On a multi-site host, set `tenantField` if the site field isn't called `tenant`. A result, sample or sequence keeps the site it was made for, so nobody can move it to another site's readers.

## External samples

A sample is `internal` (the host's own material, from a kit, an upload or a historic record) or `external` (a record from a paper, a public database, a validated panel or an institution). `origin` is set once. Internal samples have `source`, and may have a kit and consent. External samples have none of those, and instead fill the `external` group:

| Field | What it holds |
| --- | --- |
| `sourceType` | `paper`, `public-database`, `validated-panel` or `institution`. Required. |
| `accession`, `database` | The source's own identifier and the database it belongs to. Unique together where both are set. |
| `voucher.institution`, `voucher.catalogNumber` | The specimen, as a collection names it. |
| `collector`, `permit` | Restricted: read and changed only by the check you pass as `external.restrictedAccess`. Default nobody. |
| `collectionDatePrecision` | `day`, `month`, `year` or `unknown`, for the sample's `collectedAt`. |
| `dataLicense` | `cc0`, `cc-by`, `cc-by-nc`, `insdc`, `other` or `unknown`. Left out, it is `unknown`. |
| `dataLicenseNote`, `citation`, `doi` | The terms as written, and the paper or dataset. |
| `url` | The source's own page. Readable only by the check you pass as `external.urlAccess`. Default nobody. |
| `sourceRelease`, `importRun` | Relations to your own collections, added when you name them in `external.relations`. |

The plugin knows no roles. Pass your own checks:

```ts
records: {
  external: {
    restrictedAccess: ({ req }) => req.user?.role === 'super-admin', // collector and permit
    urlAccess: ({ req }) => Boolean(req.user?.role),                   // the source link
    relations: { sourceReleases: 'source-releases', importRuns: 'import-runs' },
  },
  ecoregions: { land: { dataset: 'RESOLVE Ecoregions', version: '2017' } },
}
```

**The data license fails closed.** `unknown` means the record is a pointer to the source: no copy of its reads may be kept and nothing may be passed on, until a curator sets a real license. `licenseTerms(license)` gives the same answer to your own code (`keepCopy`, `redistribute`, `commercial`, `pointerOnly`); `other` keeps a copy and passes nothing on, because a person has to read the note.

`rawReads[]` holds pointers to raw reads (an SRA run, a URL, your storage key), each with its SHA-256 and a `tier`: `external` (the source holds it), `cache` (a copy that may be cleared), `hot` or `deep-archive` (your own reads). An external sample's reads are `external`, or `cache` once its license allows a copy. An internal sample's reads are `hot` or `deep-archive`. The reads themselves are never stored here.

`ecoregion` is the most any page may show of where a sample came from, in three realms: `land`, `marine` and `freshwater`. Each value carries the dataset and version it came from, and a realm you pin in `ecoregions` refuses any other set. Precise localities never enter the plugin: a sample with a coordinate anywhere in it is refused. Keep them in your own collection, with your own audit.

