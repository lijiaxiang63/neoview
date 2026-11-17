"""Regenerate synthetic-only GRF fixtures: python scripts/generate-grf-tail-reference.py.
Requires NumPy and SciPy; neither is a runtime/test dependency of Neoview.
"""
import json
from pathlib import Path
import numpy as np
import scipy
from scipy import ndimage, stats, special

rng = np.random.default_rng(0)
noise = ndimage.gaussian_filter(rng.standard_normal((30, 30, 30)), sigma=2)
t = noise / noise.std()
t[10:20, 10:20, 10:20] += 12
# Quantization makes a small reference lookup possible; avoid implicit-mask zeros.
t = np.round(t * 4) / 4
t[t == 0] = 0.125
unique = np.unique(t)
refs = []
for df in [1, 5, 20, 379, 1000]:
    for value in [0, 0.1, 2, 5, 9, 19, 40, 100]:
        logp = stats.t.logsf(value, df)
        if not np.isfinite(logp):
            x = df / (df + value * value)
            a = df / 2
            logp = (-np.log(2) + a*np.log(x) + 0.5*np.log1p(-x)
                    - np.log(a) - special.betaln(a, 0.5)
                    + np.log(special.hyp2f1(a+0.5, 1, a+1, x)))
        refs.append([df, value, float(-special.ndtri_exp(logp))])
out = dict(scipy=scipy.__version__, dims=[30,30,30], dof=379,
           values=t.ravel().tolist(),
           zByT={str(v): float(np.sign(v)*stats.norm.isf(stats.t.sf(abs(v),379))) for v in unique},
           tReferences=refs,
           pReferences=[[p,float(stats.norm.isf(p))] for p in [0.5,0.05,1e-15,1e-30,1e-100,1e-300,np.nextafter(0.,1.)]])
path = Path(__file__).resolve().parents[1] / 'tests/fixtures/grf-tail-reference.json'
path.parent.mkdir(exist_ok=True)
path.write_text(json.dumps(out, separators=(',',':'), allow_nan=False)+'\n')
