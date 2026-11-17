# Strong-T GRF numerical regression

Based on Neoview main `c2e6ffbbcf6147c13d1b57674b1cc088471f2750` and the approach in
[GrouVox PR #5](https://github.com/lijiaxiang63/GrouVox/pull/5).

## Change

The old `normalInv(1 - max(p, 1e-15))` conversion plateaued at Z=7.9414444874.
That is not harmless for GRF: `computeCorrection` estimates smoothness from the
converted map unless `smoothnessOverride` is supplied.

The TypeScript implementation now evaluates Student-t log survival through the
incomplete-beta continued fraction, keeping its front factor in log space.
Computing log(x) without squaring T also avoids overflow of finite large T.
The normal inverse uses lower-tail symmetry in the ordinary range; below log(p)
=-690 it inverts the Cephes log-tail, avoiding probability underflow and overflow
in the ordinary quantile refinement. No new runtime dependency is required.

Positive representable p/F probabilities retain their magnitude. An already-zero
p/F tail cannot recover lost information and uses Number.MIN_VALUE as a finite
fallback; this is distinct from T, whose log tail is retained. The existing upper
p endpoint policy is preserved. This does not implement a log-survival F distribution.

The GRF formula, mask rules, smoothness estimator, and external-override selection
are unchanged. Estimation from a statistic map remains an approximation to
residual-based smoothness; this fix only removes the numerical clipping bias.

## Independent references and native GRF result

`python scripts/generate-grf-tail-reference.py` regenerates the fixture with
NumPy and SciPy (validated with SciPy 1.17.0). The fixture stores both synthetic T
values and independently calculated SciPy equivalent Z values. Tests need no Python.
The underflowed T=150 and T=1000 references also match the 50-digit mpmath values
reported in GrouVox PR #5.

| T (df=379) | Old Z | Fixed Z / reference |
|---|---:|---:|
| 9 | 7.9414444874 | 8.5623244061197 |
| 19 | 7.9414444874 | 15.9147242039993 |
| 150 | 7.9414444874 | 39.4035461107778 |

The synthetic fixture uses a seeded 30x30x30 Gaussian-smoothed noise field
(sigma=2), normalized to unit SD, with +12 in a 10x10x10 region. Values are rounded
to quarter steps to keep the reference lookup small, and zeros replaced by 0.125
to avoid differences in implicit masks. Both signs are tested. These results are
from Neoview's native `computeCorrection`, with two tails, voxel p=.001, cluster
p=.05, connectivity=26, and unit spacing:

| Quantity | Old conversion | Fixed conversion | Independent SciPy Z map |
|---|---:|---:|---:|
| dLh | 0.0827087049986 | 0.0903212238042 | 0.0903212238042 |
| FWHM X | 3.98793283472 | 3.77825400125 | 3.77825400125 |
| FWHM Y | 3.75570792378 | 3.66741586873 | 3.66741586873 |
| FWHM Z | 3.72681051288 | 3.68881652180 | 3.68881652180 |
| Minimum cluster voxels | 41 | 38 | 38 |
| Surviving voxels | 1000 | 1000 | 1000 |

The surviving strong cluster is unchanged in this example. The changed cluster
threshold could affect marginal clusters; its size and direction are data-dependent.
This is synthetic validation, not evidence of an effect in patient data. It is a
new fixture, so its numbers need not equal the earlier offline 39/41 example.
With external dLh=.005, the one- and two-tailed tests preserve the override,
cluster threshold, and survival mask despite the changed Z conversion.

## Checks

- Scalar comparisons at df=1,5,20,379,1000, positive/negative T and zero, absolute
  Z error tolerance 1e-9.
- Extreme positive p through Number.MIN_VALUE; F tail and zero-tail fallback.
- Dense monotonicity grid to T=200, plus very large finite T through Number.MAX_VALUE.
- Automatic smoothness, native cluster thresholds and masks versus independent
  SciPy Z maps, and external smoothness overrides.
- `npx vitest run tests/grfStrongT.test.ts tests/pValues.test.ts tests/distributions.test.ts tests/correctionCore.test.ts tests/smoothness.test.ts`: 108 passed.
- `npm test`: 1000 passed, 2 skipped (86 suites passed, 1 skipped).
- `npm run typecheck`: passed.
- ESLint on changed TypeScript files: passed.

Validation ran on Node 24.22.1; package.json requests Node >=26.5.0. Electron
packaging/UI tests were not run. No patient images were read.
