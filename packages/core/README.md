# @extantape/onephylogeny-core

Species-agnostic sequence records, GenBank and FASTA parsing, reference coordinates, coverage-aware comparison, haplotypes, frame checks, profiles and record sheets. No dependencies; runs in browsers, Node, workers and Tauri.

See the [repository](https://github.com/ExtantApe/OnePhylogeny) for documentation.

## JSON Schemas

The file formats ship as JSON Schemas (draft-07) in `schemas/`: `profile`, `curation`, `panel` and `result`. Import them as `@extantape/onephylogeny-core/schemas/panel.schema.json`. They're generated from this package's types and refuse unknown fields.

## Identity match

`identityMatch(loci, options)` compares two samples' genotypes at nuclear, diploid loci and says whether they come from one individual. It returns counts, probability of identity (unrelated and full siblings), log10 likelihood ratios of one individual against each, a binomial test of the mismatch count, and a verdict: `match`, `no-match` or `insufficient`, with reasons as codes and plain words. It fails closed: anything it can't decide is `insufficient`.

- Mitochondrial, haploid and sex-linked hemizygous loci are left out. A mitochondrial match means the same maternal line only, never the same individual.
- Without allele frequencies the verdict is `insufficient`, because counts alone can't separate one animal from its sibling. Frequencies that are negative, don't sum to about 1, or lack an observed allele are left out and counted.
- The statistics assume independent loci. Linked loci make them look stronger than they are.
- Defaults (`IDENTITY_DEFAULTS`): error rate 0.01, at least 50 loci, PIDsib at most 1e-4, both log10 ratios at least 3, mismatch test alpha 0.001. Taxa that reproduce clonally need `clonal: true`.
- The formulas are in the comment at the top of `src/identity.ts`. The result is plain JSON.
