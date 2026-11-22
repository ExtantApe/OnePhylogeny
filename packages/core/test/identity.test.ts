import { describe, expect, it } from 'vitest'

import { IDENTITY_DEFAULTS, IDENTITY_METHOD, IdentityError, identityMatch, type IdentityLocus } from '../src'

// Seeded generator (mulberry32) so every simulation is repeatable.
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Panel = { id: string; alleles: string[]; p: number[] }
function makePanel(n: number, rand: () => number): Panel[] {
  return Array.from({ length: n }, (_, i) => {
    const k = 4 + Math.floor(rand() * 4)
    const raw = Array.from({ length: k }, () => 0.3 + rand())
    const sum = raw.reduce((a, b) => a + b, 0)
    return { id: `L${i}`, alleles: Array.from({ length: k }, (_, j) => `a${j}`), p: raw.map((x) => x / sum) }
  })
}
const draw = (l: Panel, rand: () => number) => {
  let u = rand()
  for (let i = 0; i < l.p.length; i++) {
    u -= l.p[i]!
    if (u <= 0) return l.alleles[i]!
  }
  return l.alleles[l.alleles.length - 1]!
}
const freqs = (l: Panel) => Object.fromEntries(l.alleles.map((a, i) => [a, l.p[i]!]))
type G = [string, string]
const toLoci = (panel: Panel[], a: G[], b: G[]): IdentityLocus[] => panel.map((l, i) => ({ id: l.id, a: a[i]!, b: b[i]!, frequencies: freqs(l) }))
const genos = (panel: Panel[], rand: () => number): G[] => panel.map((l) => [draw(l, rand), draw(l, rand)])
const err = (panel: Panel[], g: G[], e: number, rand: () => number): G[] => g.map((x, i) => x.map((al) => (rand() < e ? draw(panel[i]!, rand) : al)) as G)
// Child gets one random allele from each parent.
const child = (m: G[], f: G[], rand: () => number): G[] => m.map((x, i) => [x[rand() < 0.5 ? 0 : 1], f[i]![rand() < 0.5 ? 0 : 1]] as G)
const parentChild = (p: G[], other: G[], rand: () => number): G[] => child(p, other, rand)

const AB = { A: 0.5, B: 0.5 }
const lg = Math.log10

describe('identityMatch: hand-worked numbers', () => {
  // One locus, alleles A and B at 0.5 each, both samples AB, error rate 0.
  // PID    = 2 * 0.5^4 + (2*0.5*0.5)^2 = 0.125 + 0.25 = 0.375
  // PIDsib = 0.25 + 0.5*0.5 + 0.5*0.25 - 0.25*0.125 = 0.59375   (sum p^2 = 0.5, sum p^4 = 0.125)
  // Same: P(AB) = 2*0.25 = 0.5 and the true genotype is AB either way round, so Psame = 0.5. Unrelated: 0.5*0.5 = 0.25. LR = 2.
  // Siblings: P1 = 0.25, Psib = 0.25*0.25 + 0.5*0.25 + 0.25*0.5 = 0.3125. LR = 0.5/0.3125 = 1.6.
  it('gives PID, PIDsib and both likelihood ratios for one locus', () => {
    const r = identityMatch([{ id: 'x', a: ['A', 'B'], b: ['B', 'A'], frequencies: AB }], { errorRate: 0, minLoci: 1 })
    expect(r.pid!.unrelated).toBeCloseTo(0.375, 12)
    expect(r.pid!.sibling).toBeCloseTo(0.59375, 12)
    expect(r.likelihood!.log10LRUnrelated).toBeCloseTo(lg(2), 12)
    expect(r.likelihood!.log10LRSibling).toBeCloseTo(lg(1.6), 12)
  })

  // Both samples AA, alleles A and B at 0.5, error rate 0.1. r(A|A) = 0.9 + 0.05 = 0.95, r(A|B) = 0.05.
  // f(AA | AA) = 0.9025, f(AA | AB) = f(AA | BA) = 0.0475, f(AA | BB) = 0.0025. Each true genotype has weight 0.25.
  // P(AA) = 0.25 * (0.9025 + 0.0475 + 0.0475 + 0.0025) = 0.25. Psame = 0.25 * 0.819025 = 0.20475625. Unrelated = 0.0625.
  // LR unrelated = 3.2761.
  it('applies the error model', () => {
    const r = identityMatch([{ id: 'x', a: ['A', 'A'], b: ['A', 'A'], frequencies: AB }], { errorRate: 0.1, minLoci: 1 })
    expect(r.likelihood!.log10LRUnrelated).toBeCloseTo(lg(3.2761), 12)
    // Siblings: FA(A) = 0.5*f(AA|AA) + 0.5*f(AA|AB) = 0.475 and FA(B) = 0.5*0.0475 + 0.5*0.0025 = 0.025.
    // P1 = 0.5*0.475^2 + 0.5*0.025^2 = 0.1128125 + 0.0003125 = 0.113125; Psib = 0.25*0.0625 + 0.5*P1 + 0.25*0.20475625.
    const p1 = 0.5 * 0.475 ** 2 + 0.5 * 0.025 ** 2
    const psib = 0.25 * 0.0625 + 0.5 * p1 + 0.25 * 0.20475625
    expect(r.likelihood!.log10LRSibling).toBeCloseTo(lg(0.20475625 / psib), 12)
  })

  // Two loci multiply. Locus 1 as above (PID 0.375). Locus 2: A 0.7, B 0.2, C 0.1.
  // sum p^2 = 0.54, sum p^4 = 0.2401 + 0.0016 + 0.0001 = 0.2418, cross = (0.28)^2 + (0.14)^2 + (0.04)^2 = 0.0784 + 0.0196 + 0.0016 = 0.0996.
  // PID = 0.2418 + 0.0996 = 0.3414. PIDsib = 0.25 + 0.27 + 0.5*0.2916 - 0.25*0.2418 = 0.25 + 0.27 + 0.1458 - 0.06045 = 0.60535.
  // Both samples AB at locus 1 and AA at locus 2 (error 0). Locus 2: Psame = 0.49, Punrel = 0.49^2 = 0.2401, LR = 0.49/0.2401.
  it('multiplies across loci and leaves out loci without frequencies', () => {
    const loci: IdentityLocus[] = [
      { id: 'one', a: ['A', 'B'], b: ['A', 'B'], frequencies: AB },
      { id: 'two', a: ['A', 'A'], b: ['A', 'A'], frequencies: { A: 0.7, B: 0.2, C: 0.1 } },
      { id: 'three', a: ['A', 'A'], b: ['A', 'A'] },
    ]
    const r = identityMatch(loci, { errorRate: 0, minLoci: 1 })
    expect(r.pid!.loci).toBe(2)
    expect(r.frequencies.lociWithoutFrequencies).toBe(1)
    expect(r.pid!.unrelated).toBeCloseTo(0.375 * 0.3414, 12)
    expect(r.pid!.sibling).toBeCloseTo(0.59375 * 0.60535, 12)
    expect(r.likelihood!.log10LRUnrelated).toBeCloseTo(lg(2) + lg(0.49 / 0.2401), 12)
  })
})

describe('identityMatch: counts', () => {
  it('counts IBS2, IBS1 and IBS0, and never counts missing data as match or mismatch', () => {
    const loci: IdentityLocus[] = [
      { id: '1', a: ['A', 'B'], b: ['B', 'A'] }, // IBS2
      { id: '2', a: ['A', 'A'], b: ['A', 'B'] }, // IBS1
      { id: '3', a: ['A', 'B'], b: ['C', 'D'] }, // IBS0
      { id: '4', a: null, b: ['A', 'A'] }, // missing
      { id: '5', a: ['A', 'A'], b: null }, // missing
      { id: '6', a: null, b: null }, // missing
    ]
    const c = identityMatch(loci).counts
    expect(c).toMatchObject({ offered: 6, missingInEither: 3, calledBoth: 3, compared: 3, ibs2: 1, ibs1: 1, ibs0: 1, mismatches: 2 })
    expect(c.concordance).toBeCloseTo(1 / 3, 12)
  })

  it('has no concordance when nothing was compared', () => {
    const r = identityMatch([{ id: '1', a: null, b: null }])
    expect(r.counts.concordance).toBeNull()
    expect(r.mismatchTest).toBeNull()
    expect(r.verdict).toBe('insufficient')
  })
})

describe('identityMatch: verdicts', () => {
  const rand = rng(1)
  const panel = makePanel(200, rand)

  it('says match for identical genotypes over 200 simulated loci', () => {
    const g = genos(panel, rand)
    const r = identityMatch(toLoci(panel, g, g))
    expect(r.verdict).toBe('match')
    expect(r.reasons.map((x) => x.code)).toEqual(['match-criteria-met'])
    expect(r.counts.compared).toBe(200)
    expect(r.counts.concordance).toBe(1)
  })

  it('still says match for a true duplicate with 1% injected errors', () => {
    const rr = rng(2)
    for (let n = 0; n < 40; n++) {
      const g = genos(panel, rr)
      const r = identityMatch(toLoci(panel, err(panel, g, 0.01, rr), err(panel, g, 0.01, rr)))
      expect(r.verdict).toBe('match')
    }
  })

  it('never says match for full siblings, parent and offspring, or unrelated pairs', () => {
    const rr = rng(3)
    let noMatch = 0
    for (let n = 0; n < 300; n++) {
      const m = genos(panel, rr)
      const f = genos(panel, rr)
      const other = genos(panel, rr)
      for (const [x, y] of [
        [child(m, f, rr), child(m, f, rr)],
        [m, child(m, f, rr)],
        [m, other],
      ] as [G[], G[]][]) {
        const r = identityMatch(toLoci(panel, x, y))
        expect(r.verdict).not.toBe('match')
        if (r.verdict === 'no-match') noMatch++
      }
    }
    expect(noMatch).toBe(900)
  })

  it('says insufficient below minLoci, even for identical genotypes', () => {
    const p = panel.slice(0, 49)
    const g = genos(p, rand)
    const r = identityMatch(toLoci(p, g, g))
    expect(r.verdict).toBe('insufficient')
    expect(r.reasons.map((x) => x.code)).toContain('too-few-loci')
    expect(identityMatch(toLoci(p, g, g), { minLoci: 49 }).verdict).toBe('match')
  })

  it('says insufficient with no frequencies, even for identical genotypes', () => {
    const g = genos(panel, rand)
    const r = identityMatch(toLoci(panel, g, g).map(({ frequencies: _f, ...rest }) => rest))
    expect(r.verdict).toBe('insufficient')
    expect(r.reasons.map((x) => x.code)).toContain('no-allele-frequencies')
    expect(r.pid).toBeNull()
    expect(r.likelihood).toBeNull()
  })

  it('says insufficient when siblings would look identical too often', () => {
    const g = genos(panel, rand)
    const r = identityMatch(toLoci(panel, g, g), { maxPidSib: 1e-300 })
    expect(r.verdict).toBe('insufficient')
    expect(r.reasons.map((x) => x.code)).toContain('pid-sibling-too-high')
  })

  it('says insufficient when the likelihood ratios do not clear the bar', () => {
    const g = genos(panel, rand)
    const r = identityMatch(toLoci(panel, g, g), { minLog10LR: 1e6 })
    expect(r.verdict).toBe('insufficient')
    expect(r.reasons.map((x) => x.code)).toEqual(['likelihood-ratio-too-low'])
  })

  it('says no-match when the mismatch rate is above what the error rate explains', () => {
    const rr = rng(4)
    const g = genos(panel, rr)
    const r = identityMatch(toLoci(panel, g, genos(panel, rr)))
    expect(r.verdict).toBe('no-match')
    expect(r.mismatchTest!.passed).toBe(false)
    expect(r.reasons.map((x) => x.code)).toContain('mismatch-rate-too-high')
  })

  it('says no-match when siblings explain the data better, even with the mismatch test passing', () => {
    // 50 loci at 0.5 / 0.5: 12 of them AB against AA, 38 AB against AB, error rate 0.05. The mismatch test allows 12
    // mismatches (p about 0.2), but the sibling ratio comes out below 0 (about -0.82 in log10).
    const loci: IdentityLocus[] = Array.from({ length: 50 }, (_, i) => ({ id: `l${i}`, a: ['A', 'B'], b: i < 12 ? ['A', 'A'] : ['A', 'B'], frequencies: AB }))
    const r = identityMatch(loci, { errorRate: 0.05, maxPidSib: 1 })
    expect(r.mismatchTest!.passed).toBe(true)
    expect(r.likelihood!.log10LRSibling).toBeLessThan(0)
    expect(r.verdict).toBe('no-match')
    expect(r.reasons.map((x) => x.code)).toEqual(['sibling-more-likely'])
  })

  it('says insufficient for a clonal taxon, even for identical genotypes', () => {
    const g = genos(panel, rand)
    const r = identityMatch(toLoci(panel, g, g), { clonal: true })
    expect(r.verdict).toBe('insufficient')
    expect(r.reasons.map((x) => x.code)).toEqual(['clonal-taxon'])
  })
})

describe('identityMatch: refusals', () => {
  const rr = rng(6)
  const panel = makePanel(100, rr)
  const g = genos(panel, rr)

  it('leaves out mitochondrial, haploid and hemizygous loci', () => {
    const base = toLoci(panel, g, g)
    const mixed = base.map((l, i) => (i < 10 ? { ...l, kind: 'mitochondrial' as const } : i < 20 ? { ...l, kind: 'haploid' as const } : i < 30 ? { ...l, kind: 'sex-linked-hemizygous' as const } : l))
    const r = identityMatch(mixed)
    expect(r.counts.excludedNotDiploidNuclear).toBe(30)
    expect(r.counts.compared).toBe(70)
    expect(r.frequencies.lociUsed).toBe(70)
  })

  it('does not inspect the genotypes of left-out loci', () => {
    const r = identityMatch([{ id: 'm', kind: 'mitochondrial', a: ['H1'] as unknown as [string, string], b: null }])
    expect(r.counts.excludedNotDiploidNuclear).toBe(1)
  })

  it('says a mitochondrial-only set is insufficient, because it shows the same maternal line only', () => {
    const r = identityMatch(toLoci(panel, g, g).map((l) => ({ ...l, kind: 'mitochondrial' as const })))
    expect(r.verdict).toBe('insufficient')
    expect(r.reasons.map((x) => x.code)).toContain('mitochondrial-only')
    expect(r.reasons.find((x) => x.code === 'mitochondrial-only')!.text).toMatch(/same maternal line only, never the same individual/)
  })

  it('excludes bad frequencies from the frequency statistics, counts them by reason, and never guesses', () => {
    const base = toLoci(panel, g, g)
    const bad = base.map((l, i) => {
      if (i < 3) return { ...l, frequencies: Object.fromEntries(Object.entries(l.frequencies!).map(([k, v]) => [k, v * 0.5])) } // sums to 0.5
      if (i < 5) return { ...l, frequencies: { ...l.frequencies!, [Object.keys(l.frequencies!)[0]!]: -0.1 } }
      if (i < 9) return { ...l, frequencies: { zzz: 1 } } // lacks the observed alleles
      return l
    })
    const r = identityMatch(bad)
    expect(r.frequencies.lociExcluded).toEqual({ 'frequencies-not-summing-to-one': 3, 'frequencies-negative': 2, 'frequencies-missing-observed-allele': 4 })
    expect(r.frequencies.lociUsed).toBe(91)
    expect(r.counts.compared).toBe(100)
    const clean = identityMatch(base.slice(9))
    expect(r.pid!.log10Unrelated).toBeCloseTo(clean.pid!.log10Unrelated, 9)
    expect(r.likelihood!.log10LRSibling).toBeCloseTo(clean.likelihood!.log10LRSibling, 9)
  })

  it('treats an observed allele with frequency 0 as missing', () => {
    const r = identityMatch([{ id: 'x', a: ['A', 'B'], b: ['A', 'B'], frequencies: { A: 1, B: 0 } }], { minLoci: 1 })
    expect(r.frequencies.lociExcluded['frequencies-missing-observed-allele']).toBe(1)
  })

  it('throws on an error rate outside [0, 0.5) and on non-finite inputs', () => {
    const one: IdentityLocus[] = [{ id: 'x', a: ['A', 'B'], b: ['A', 'B'], frequencies: AB }]
    for (const errorRate of [-0.01, 0.5, 0.9, NaN, Infinity]) expect(() => identityMatch(one, { errorRate })).toThrow(IdentityError)
    expect(() => identityMatch(one, { minLoci: NaN })).toThrow(IdentityError)
    expect(() => identityMatch(one, { minLog10LR: Infinity })).toThrow(IdentityError)
    expect(() => identityMatch([{ id: 'x', a: ['A', 'B'], b: ['A', 'B'], frequencies: { A: NaN, B: 0.5 } }])).toThrow(/finite/)
    expect(() => identityMatch([{ id: 'x', a: ['A', ''], b: ['A', 'B'] }])).toThrow(/two non-empty alleles/)
    expect(() => identityMatch([one[0]!, one[0]!])).toThrow(/twice/)
    expect(() => identityMatch(one, { errorRate: 0 })).not.toThrow()
  })
})

describe('identityMatch: numbers and shape', () => {
  it('keeps the logs finite over 5,000 loci', () => {
    const rr = rng(7)
    const panel = makePanel(5000, rr)
    const g = genos(panel, rr)
    const r = identityMatch(toLoci(panel, g, g))
    expect(r.pid!.unrelated).toBe(0) // underflows as a plain number
    expect(Number.isFinite(r.pid!.log10Unrelated)).toBe(true)
    expect(r.pid!.log10Sibling).toBeLessThan(-100)
    expect(Number.isFinite(r.likelihood!.log10LRSibling)).toBe(true)
    expect(r.verdict).toBe('match')
  })

  it('stays finite and JSON-safe when the error rate is 0 and the genotypes disagree', () => {
    const r = identityMatch([{ id: 'x', a: ['A', 'A'], b: ['B', 'B'], frequencies: AB }], { errorRate: 0, minLoci: 1 })
    expect(r.likelihood!.log10LRUnrelated).toBe(-300 - lg(0.0625))
    expect(JSON.parse(JSON.stringify(r))).toEqual(r)
  })

  it('returns plain JSON that round-trips unchanged, with the method and defaults exported', () => {
    const rr = rng(8)
    const panel = makePanel(80, rr)
    const g = genos(panel, rr)
    const r = identityMatch(toLoci(panel, g, genos(panel, rr)))
    expect(JSON.parse(JSON.stringify(r))).toEqual(r)
    expect(r.method).toEqual(IDENTITY_METHOD)
    expect(r.options).toEqual(IDENTITY_DEFAULTS)
    expect(IDENTITY_DEFAULTS).toMatchObject({ errorRate: 0.01, minLoci: 50, maxPidSib: 1e-4, minLog10LR: 3 })
  })

  it('is deterministic', () => {
    const rr = rng(9)
    const panel = makePanel(60, rr)
    const g = genos(panel, rr)
    const loci = toLoci(panel, g, err(panel, g, 0.01, rr))
    expect(identityMatch(loci)).toEqual(identityMatch(loci))
  })
})
