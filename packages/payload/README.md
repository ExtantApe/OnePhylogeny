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
| `accession`, `database` | The source's own identifier and the database it belongs to. Unique together where both are set, without regard to case or spacing: `GenBank AB000001` and ` genbank ab000001` are one record. A hidden `sourceKey` holds the normalized pair under a sparse unique index, so two writes in the same instant can't both land. |
| `voucher.institution`, `voucher.catalogNumber` | The specimen, as a collection names it. |
| `collector`, `permit` | Restricted: read and changed only by the check you pass as `external.restrictedAccess`. Default nobody. |
| `collectionDatePrecision` | `day`, `month`, `year` or `unknown`, for the sample's `collectedAt`. |
| `dataLicense` | `cc0`, `cc-by`, `cc-by-nc`, `insdc`, `other` or `unknown`. Left out, it is `unknown`. `other` and `unknown` both allow nothing. |
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

**The data license fails closed.** `unknown` means the record is a pointer to the source: no copy of its reads may be kept and nothing may be passed on, until a curator sets a real license. `other` gets the same answer: its terms are in `dataLicenseNote`, which only a person can read, and a check that can't decide says no. Once someone has read them, move the record to a real license. `licenseTerms(license)` gives the same answers to your own code (`keepCopy`, `redistribute`, `commercial`, `pointerOnly`).

The accession check works on MongoDB and Postgres. Its tests against Postgres skip unless asked: run `pnpm test:postgres` in `packages/payload` (needs Docker; it starts one throwaway Postgres 17 container, pinned by image digest, on 127.0.0.1 and removes it; a run killed part way leaves the container for you to remove) or set `ONEPHYLOGENY_TEST_POSTGRES_URL` to an empty throwaway database. The tests push their schema into that database, so one that already holds a table is refused. The Postgres adapter is a dev dependency only.

`rawReads[]` holds pointers to raw reads (an SRA run, a URL, your storage key), each with its SHA-256 and a `tier`: `external` (the source holds it), `cache` (a copy that may be cleared), `hot` or `deep-archive` (your own reads). An external sample's reads are `external`, or `cache` once its license allows a copy. An internal sample's reads are `hot` or `deep-archive`. The reads themselves are never stored here.

`ecoregion` is the most any page may show of where a sample came from, in three realms: `land`, `marine` and `freshwater`. Each value carries the dataset and version it came from, and a realm you pin in `ecoregions` refuses any other set. Precise localities never enter the plugin: a sample with a coordinate anywhere in it is refused, whether as a field named for one (`lat`, `lon`, `coordinates` and the like) or as text that reads like one in any field (`4.61 N 74.08 W`, `4°36'35"N`, `4.6097, -74.0817`). The refusal names the field. `looksLikeCoordinates(text)` is the same check, for your own code. Keep localities in your own collection, with your own audit.

### Importing GenBank records

```ts
import { importGenBank } from '@extantape/payload-plugin-onephylogeny'

const report = await importGenBank(payload, genBankText, { subject: referenceSubjectId, req })
// { created: [{ accession, id }], duplicates: [{ accession, id }], failed: [{ accession, reason }] }
```

Each record becomes an external sample: `public-database`, `GenBank`, the accession without its version, the voucher, collector and date precision where the record gives them, its citation, a link to the record in `url` (so your `urlAccess` rule governs it), and a `rawReads` pointer that names the versioned accession (`PQ562694.1`), checked by the sequence's SHA-256. GenBank states no license, so `dataLicense` is `unknown` and only a pointer is kept; `tier: 'cache'` is refused. `subject` is yours, an id or a function of the record: the plugin doesn't decide what a reference record is.

**Access.** Pass `req` (the request of the person importing) and every read and write runs as that user, under your access rules: a user who may not create samples gets each record back under `failed`, and `duplicates` names only samples they may read. Without `req` the import runs with full access, like any Local API job, so it belongs only in trusted server code that has already checked who is asking. Never wire it to an upload or a request without `req`.

**Place.** The importer never reads `lat_lon`, `geo_loc_name` or `country`, so no place qualifier reaches a sample. A reference title or citation keeps the words its authors wrote, which may name a country. A voucher or citation whose text reads like a coordinate is refused, like any other sample, and lands under `failed`. When a record's only reference is its direct submission, the citation is the authors and title alone, because the JOURNAL line there is the submitter's postal address.

Running it twice makes nothing new and lists the accessions already held. `genBankToExternalSample(record)` does the mapping alone. The test fixture is five real public records in `fixtures/external/`.

