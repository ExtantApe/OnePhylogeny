/**
 * Individual-identity match statistics: do two samples come from the same individual?
 *
 * Species-neutral and pure. It takes two samples' genotypes at nuclear, diploid loci and, if the caller has them, allele
 * frequencies from a reference panel. It returns counts, probabilities of identity, likelihood ratios and a verdict. It reads
 * nothing, writes nothing, and depends on no other module. The result is plain JSON, so a host can store it unchanged as
 * evidence for a curator.
 *
 * The verdict fails closed. `match` needs every check to pass. Anything the function can't decide is `insufficient`.
 *
 * Mitochondrial, haploid and sex-linked hemizygous loci are left out. A mitochondrial match means the same maternal line
 * only, never the same individual. A marker set that is only mitochondrial returns `insufficient` for that reason.
 *
 * Both probabilities of identity and both likelihood ratios multiply across loci, so they assume the loci are independent
 * (unlinked and in Hardy-Weinberg proportions). Linked loci make the numbers look stronger than they are. The result gives
 * the number of loci each statistic used. Taxa that reproduce clonally (obligate parthenogens) need `clonal: true`:
 * identical genotypes there don't mean one individual.
 *
 * Probability of identity, per locus, with allele frequencies p_i (Taberlet and Luikart 1999; Waits et al. 2001, Molecular
 * Ecology 10:249):
 *   unrelated: PID    = sum_i p_i^4 + sum_{i<j} (2 p_i p_j)^2
 *   siblings:  PIDsib = 0.25 + 0.5 sum_i p_i^2 + 0.5 (sum_i p_i^2)^2 - 0.25 sum_i p_i^4
 * Across loci the values are multiplied, worked in log10 so thousands of loci don't underflow.
 *
 * Likelihood ratios. Each sample's genotype is read from a true genotype (t1, t2) with a per-allele error: each allele is
 * read correctly with probability 1 - e, and with probability e it is replaced by a draw from the population frequencies.
 * So r(x | t) = (1 - e) [x = t] + e p_x. For an observed unordered genotype {x1, x2}:
 *   f(x | t1, t2) = r(x1 | t1) r(x2 | t2) + [x1 != x2] r(x2 | t1) r(x1 | t2)
 * and a true genotype has Hardy-Weinberg weight p_t1 p_t2 (ordered). Then, for the observed pair A and B at a locus:
 *   P(A) = sum_t w(t) f(A | t)                                  (same for B)
 *   same individual: Psame = sum_t w(t) f(A | t) f(B | t)
 *   unrelated:       Punrel = P(A) P(B)
 *   full siblings:   Psib = 0.25 P(A) P(B) + 0.5 P1 + 0.25 Psame, with P1 = sum_s p_s FA(s) FB(s)
 *                    and FA(s) = sum_a p_a f(A | s, a)   (one allele identical by descent; k0, k1, k2 = 0.25, 0.5, 0.25)
 * The log10 LR is the sum over loci of log10(Psame / Punrel) and of log10(Psame / Psib). Each per-locus probability is
 * floored at 1e-300 so the logs stay finite and JSON-safe when the error rate is 0.
 *
 * Mismatch test. A locus is a mismatch when the two samples share fewer than 2 alleles. If both are reads of one genotype
 * with error rate e, a locus mismatches with probability at most q = 1 - (1 - e)^4 (four allele reads, any one wrong).
 * The test is a one-sided binomial: the chance of at least the observed number of mismatching loci out of those compared,
 * at probability q. It fails when that chance is below `mismatchAlpha` (default 0.001). Using the upper bound q keeps the
 * test from calling `no-match` too eagerly.
 */

export const IDENTITY_METHOD = { name: 'onephylogeny-identity-match', version: '0.1.0' } as const

export type LocusKind = 'autosomal' | 'mitochondrial' | 'haploid' | 'sex-linked-hemizygous'

/** Two alleles in any order, or null when the sample has no call at this locus. */
export type IdentityGenotype = readonly [string, string] | null

export type IdentityLocus = {
  id: string
  /** Defaults to `autosomal`. Any other kind is left out of identity. */
  kind?: LocusKind
  a: IdentityGenotype
  b: IdentityGenotype
  /** Allele frequencies from a reference panel, keyed by allele. Optional. */
  frequencies?: Readonly<Record<string, number>>
}

export type IdentityOptions = {
  /** Assumed per-allele genotyping error rate, in [0, 0.5). Default 0.01. */
  errorRate?: number
  /** Fewer compared loci than this gives `insufficient`. Default 50. */
  minLoci?: number
  /** PIDsib above this gives `insufficient`. Default 1e-4. */
  maxPidSib?: number
  /** Both log10 likelihood ratios must reach this for `match`. Default 3. */
  minLog10LR?: number
  /** The mismatch test fails below this p-value. Default 0.001. */
  mismatchAlpha?: number
  /** Allowed distance from 1 for the sum of a locus's frequencies. Default 0.01. */
  frequencyTolerance?: number
  /** Taxon reproduces clonally: the verdict is always `insufficient`. Default false. */
  clonal?: boolean
}

export const IDENTITY_DEFAULTS = {
  errorRate: 0.01,
  minLoci: 50,
  maxPidSib: 1e-4,
  minLog10LR: 3,
  mismatchAlpha: 0.001,
  frequencyTolerance: 0.01,
  clonal: false,
} as const satisfies Required<IdentityOptions>

export type IdentityVerdict = 'match' | 'no-match' | 'insufficient'

export type IdentityReasonCode =
  | 'clonal-taxon'
  | 'mitochondrial-only'
  | 'too-few-loci'
  | 'no-allele-frequencies'
  | 'pid-sibling-too-high'
  | 'mismatch-rate-too-high'
  | 'sibling-more-likely'
  | 'likelihood-ratio-too-low'
  | 'match-criteria-met'

export type IdentityReason = { code: IdentityReasonCode; text: string }

/** Why a locus's frequencies were not used. */
export type FrequencyExclusionCode = 'frequencies-not-summing-to-one' | 'frequencies-negative' | 'frequencies-missing-observed-allele'

export type IdentityResult = {
  method: { name: string; version: string }
  options: Required<IdentityOptions>
  counts: {
    /** Loci passed in. */
    offered: number
    /** Loci left out because they are mitochondrial, haploid or hemizygous. */
    excludedNotDiploidNuclear: number
    /** Eligible loci where either sample has no call. Never counted as match or mismatch. */
    missingInEither: number
    calledBoth: number
    /** Loci compared. Equals `calledBoth`. */
    compared: number
    ibs2: number
    ibs1: number
    ibs0: number
    /** Compared loci sharing fewer than 2 alleles (IBS1 plus IBS0). */
    mismatches: number
    /** ibs2 / compared, or null when nothing was compared. */
    concordance: number | null
  }
  frequencies: {
    /** Compared loci whose frequencies were used by the PID and LR statistics. */
    lociUsed: number
    /** Compared loci with no frequencies given. */
    lociWithoutFrequencies: number
    /** Compared loci whose frequencies were refused, by reason. */
    lociExcluded: Record<FrequencyExclusionCode, number>
  }
  /** Over `frequencies.lociUsed` loci. Null when none. */
  pid: { loci: number; unrelated: number; sibling: number; log10Unrelated: number; log10Sibling: number } | null
  /** Over `frequencies.lociUsed` loci. Null when none. */
  likelihood: { loci: number; log10LRUnrelated: number; log10LRSibling: number } | null
  mismatchTest: { expectedPerLocus: number; observed: number; compared: number; pValue: number; alpha: number; passed: boolean } | null
  verdict: IdentityVerdict
  reasons: IdentityReason[]
}

export class IdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IdentityError'
  }
}

const LOG_FLOOR = -300
const log10Floor = (x: number) => (x > 0 ? Math.max(Math.log10(x), LOG_FLOOR) : LOG_FLOOR)

function resolveOptions(options: IdentityOptions): Required<IdentityOptions> {
  const o = { ...IDENTITY_DEFAULTS, ...options } as Required<IdentityOptions>
  for (const k of ['errorRate', 'minLoci', 'maxPidSib', 'minLog10LR', 'mismatchAlpha', 'frequencyTolerance'] as const) {
    if (typeof o[k] !== 'number' || !Number.isFinite(o[k])) throw new IdentityError(`Option ${k} must be a finite number.`)
  }
  if (o.errorRate < 0 || o.errorRate >= 0.5) throw new IdentityError('The error rate must be at least 0 and below 0.5.')
  if (o.minLoci < 0 || o.maxPidSib < 0 || o.mismatchAlpha < 0 || o.frequencyTolerance < 0) throw new IdentityError('minLoci, maxPidSib, mismatchAlpha and frequencyTolerance cannot be negative.')
  if (typeof o.clonal !== 'boolean') throw new IdentityError('Option clonal must be true or false.')
  return o
}

function checkGenotype(g: IdentityGenotype, locus: string, who: string): void {
  if (g === null) return
  if (!Array.isArray(g) || g.length !== 2 || g.some((x) => typeof x !== 'string' || x === '')) {
    throw new IdentityError(`Locus ${locus}: the genotype for sample ${who} must be two non-empty alleles, or null when missing.`)
  }
}

/** Log-factorials 0..n. */
function logFactorials(n: number): number[] {
  const lf = [0]
  for (let i = 1; i <= n; i++) lf.push(lf[i - 1]! + Math.log(i))
  return lf
}

/** P(X >= k) for X ~ Binomial(n, q), worked in logs. */
function binomialUpperTail(k: number, n: number, q: number): number {
  if (k <= 0) return 1
  if (q <= 0) return 0
  if (q >= 1) return 1
  const lf = logFactorials(n)
  const lq = Math.log(q)
  const l1q = Math.log1p(-q)
  const logs: number[] = []
  for (let i = k; i <= n; i++) logs.push(lf[n]! - lf[i]! - lf[n - i]! + i * lq + (n - i) * l1q)
  const m = Math.max(...logs)
  const s = logs.reduce((acc, x) => acc + Math.exp(x - m), 0)
  return Math.min(1, Math.exp(m + Math.log(s)))
}

function shared(a: readonly [string, string], b: readonly [string, string]): 0 | 1 | 2 {
  const [a1, a2] = a[0] <= a[1] ? a : [a[1], a[0]]
  const [b1, b2] = b[0] <= b[1] ? b : [b[1], b[0]]
  if (a1 === b1 && a2 === b2) return 2
  return a1 === b1 || a1 === b2 || a2 === b1 || a2 === b2 ? 1 : 0
}

type FrequencyCheck = { alleles: string[]; p: number[] } | FrequencyExclusionCode

function checkFrequencies(freq: Readonly<Record<string, number>>, observed: string[], tolerance: number, locus: string): FrequencyCheck {
  const alleles = Object.keys(freq)
  const p = alleles.map((k) => freq[k]!)
  if (p.some((x) => typeof x !== 'number' || !Number.isFinite(x))) throw new IdentityError(`Locus ${locus}: allele frequencies must be finite numbers.`)
  if (p.some((x) => x < 0)) return 'frequencies-negative'
  if (Math.abs(p.reduce((a, b) => a + b, 0) - 1) > tolerance) return 'frequencies-not-summing-to-one'
  for (const x of observed) {
    const i = alleles.indexOf(x)
    if (i < 0 || p[i]! <= 0) return 'frequencies-missing-observed-allele'
  }
  // Renormalize so tiny rounding in a panel's table can't leak into the statistics.
  const sum = p.reduce((a, b) => a + b, 0)
  return { alleles, p: p.map((x) => x / sum) }
}

function pidLocus(p: number[]): { pid: number; pidSib: number } {
  let s2 = 0
  let s4 = 0
  for (const x of p) {
    s2 += x * x
    s4 += x ** 4
  }
  let cross = 0
  for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) cross += (2 * p[i]! * p[j]!) ** 2
  return { pid: s4 + cross, pidSib: 0.25 + 0.5 * s2 + 0.5 * s2 * s2 - 0.25 * s4 }
}

/** Per-locus likelihoods of the observed pair under the three hypotheses. See the module comment for the formulas. */
function likelihoods(fa: { alleles: string[]; p: number[] }, a: readonly [string, string], b: readonly [string, string], e: number) {
  const { alleles, p } = fa
  const K = p.length
  const r = (x: number, t: number) => (1 - e) * (x === t ? 1 : 0) + e * p[x]!
  const idx = (g: readonly [string, string]) => [alleles.indexOf(g[0]), alleles.indexOf(g[1])] as const
  const [a1, a2] = idx(a)
  const [b1, b2] = idx(b)
  const f = (x1: number, x2: number, t1: number, t2: number) => r(x1, t1) * r(x2, t2) + (x1 !== x2 ? r(x2, t1) * r(x1, t2) : 0)
  let PA = 0
  let PB = 0
  let Psame = 0
  const FA = new Array<number>(K).fill(0)
  const FB = new Array<number>(K).fill(0)
  for (let t1 = 0; t1 < K; t1++) {
    for (let t2 = 0; t2 < K; t2++) {
      const w = p[t1]! * p[t2]!
      const fA = f(a1, a2, t1, t2)
      const fB = f(b1, b2, t1, t2)
      PA += w * fA
      PB += w * fB
      Psame += w * fA * fB
      FA[t1] = FA[t1]! + p[t2]! * fA
      FB[t1] = FB[t1]! + p[t2]! * fB
    }
  }
  let P1 = 0
  for (let s = 0; s < K; s++) P1 += p[s]! * FA[s]! * FB[s]!
  return { same: Psame, unrelated: PA * PB, sibling: 0.25 * PA * PB + 0.5 * P1 + 0.25 * Psame }
}

export function identityMatch(loci: readonly IdentityLocus[], options: IdentityOptions = {}): IdentityResult {
  const o = resolveOptions(options)
  if (!Array.isArray(loci)) throw new IdentityError('Loci must be a list.')
  const ids = new Set<string>()
  for (const l of loci) {
    if (typeof l?.id !== 'string' || l.id === '') throw new IdentityError('Every locus needs an id.')
    if (ids.has(l.id)) throw new IdentityError(`Locus ${l.id} appears twice.`)
    ids.add(l.id)
  }

  const counts = { offered: loci.length, excludedNotDiploidNuclear: 0, missingInEither: 0, calledBoth: 0, compared: 0, ibs2: 0, ibs1: 0, ibs0: 0, mismatches: 0 }
  const freqCounts = { lociUsed: 0, lociWithoutFrequencies: 0, lociExcluded: { 'frequencies-not-summing-to-one': 0, 'frequencies-negative': 0, 'frequencies-missing-observed-allele': 0 } as Record<FrequencyExclusionCode, number> }
  let log10Pid = 0
  let log10PidSib = 0
  let log10LRUnrelated = 0
  let log10LRSibling = 0
  let allMito = loci.length > 0

  for (const l of loci) {
    const kind = l.kind ?? 'autosomal'
    if (kind !== 'mitochondrial') allMito = false
    if (kind !== 'autosomal') {
      counts.excludedNotDiploidNuclear++
      continue
    }
    checkGenotype(l.a, l.id, 'a')
    checkGenotype(l.b, l.id, 'b')
    if (!l.a || !l.b) {
      counts.missingInEither++
      continue
    }
    counts.calledBoth++
    counts.compared++
    const s = shared(l.a, l.b)
    if (s === 2) counts.ibs2++
    else if (s === 1) counts.ibs1++
    else counts.ibs0++

    if (!l.frequencies) {
      freqCounts.lociWithoutFrequencies++
      continue
    }
    const fc = checkFrequencies(l.frequencies, [...l.a, ...l.b], o.frequencyTolerance, l.id)
    if (typeof fc === 'string') {
      freqCounts.lociExcluded[fc]++
      continue
    }
    freqCounts.lociUsed++
    const { pid, pidSib } = pidLocus(fc.p)
    log10Pid += log10Floor(pid)
    log10PidSib += log10Floor(pidSib)
    const L = likelihoods(fc, l.a, l.b, o.errorRate)
    log10LRUnrelated += log10Floor(L.same) - log10Floor(L.unrelated)
    log10LRSibling += log10Floor(L.same) - log10Floor(L.sibling)
  }

  counts.mismatches = counts.ibs1 + counts.ibs0
  const used = freqCounts.lociUsed
  const pid = used > 0 ? { loci: used, unrelated: 10 ** log10Pid, sibling: 10 ** log10PidSib, log10Unrelated: log10Pid, log10Sibling: log10PidSib } : null
  const likelihood = used > 0 ? { loci: used, log10LRUnrelated, log10LRSibling } : null

  let mismatchTest: IdentityResult['mismatchTest'] = null
  if (counts.compared > 0) {
    const q = 1 - (1 - o.errorRate) ** 4
    const pValue = binomialUpperTail(counts.mismatches, counts.compared, q)
    mismatchTest = { expectedPerLocus: q, observed: counts.mismatches, compared: counts.compared, pValue, alpha: o.mismatchAlpha, passed: pValue >= o.mismatchAlpha }
  }

  const insufficient: IdentityReason[] = []
  if (o.clonal) insufficient.push({ code: 'clonal-taxon', text: 'This taxon reproduces clonally, so identical genotypes do not mean one individual.' })
  if (allMito) insufficient.push({ code: 'mitochondrial-only', text: 'Every locus is mitochondrial. A mitochondrial match means the same maternal line only, never the same individual.' })
  if (counts.compared < o.minLoci) insufficient.push({ code: 'too-few-loci', text: `Only ${counts.compared} loci were compared; at least ${o.minLoci} are needed.` })
  if (used === 0) insufficient.push({ code: 'no-allele-frequencies', text: 'No usable allele frequencies, so counts alone cannot separate one animal from its sibling.' })
  else if (10 ** log10PidSib > o.maxPidSib) insufficient.push({ code: 'pid-sibling-too-high', text: `The chance that full siblings look identical at these ${used} loci is ${(10 ** log10PidSib).toExponential(2)}, above the limit of ${o.maxPidSib}.` })

  let verdict: IdentityVerdict
  let reasons: IdentityReason[]
  if (insufficient.length) {
    verdict = 'insufficient'
    reasons = insufficient
  } else {
    const noMatch: IdentityReason[] = []
    if (mismatchTest && !mismatchTest.passed) noMatch.push({ code: 'mismatch-rate-too-high', text: `${counts.mismatches} of ${counts.compared} loci differ, more than a ${o.errorRate} per-allele error rate explains (p = ${mismatchTest.pValue.toExponential(2)}).` })
    if (log10LRSibling < 0) noMatch.push({ code: 'sibling-more-likely', text: 'Full siblings explain the genotypes better than one individual does.' })
    if (noMatch.length) {
      verdict = 'no-match'
      reasons = noMatch
    } else if (log10LRUnrelated >= o.minLog10LR && log10LRSibling >= o.minLog10LR) {
      verdict = 'match'
      reasons = [{ code: 'match-criteria-met', text: `${counts.compared} loci compared, the mismatch rate fits the error rate, and one individual is at least 10^${o.minLog10LR} times more likely than unrelated animals or full siblings.` }]
    } else {
      verdict = 'insufficient'
      reasons = [{ code: 'likelihood-ratio-too-low', text: `One individual is not at least 10^${o.minLog10LR} times more likely than both unrelated animals and full siblings.` }]
    }
  }

  return {
    method: { ...IDENTITY_METHOD },
    options: o,
    counts: { ...counts, concordance: counts.compared > 0 ? counts.ibs2 / counts.compared : null },
    frequencies: freqCounts,
    pid,
    likelihood,
    mismatchTest,
    verdict,
    reasons,
  }
}
