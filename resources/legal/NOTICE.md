# Third-party notices

## neuroneural/brainchop models

- Source: https://github.com/neuroneural/brainchop
- Source revision: `4c87885f3a2a8835e260d521dcec922b58d91d41`
- Bundled model directories: `model5_gw_ae`, `model20chan3cls`,
  `model30chan18cls`, `model18cls`, `model30chan50cls`, `model11_gw_ae`,
  `model21_104class`, and `mindgrab`. The application includes each selected
  `model.json`, weight bundle, and available color table. Weight bundles are
  packaged under the uniform name `weights.bin` without changing their bytes.
- License: MIT; see `model/LICENSE`.

Citation requested by the source project:

Masoud, M., Hu, F., & Plis, S. (2023). Brainchop: In-browser MRI volumetric
segmentation and rendering. Journal of Open Source Software, 8(83), 5098.
https://doi.org/10.21105/joss.05098

## TensorFlow.js

- Packages: `@tensorflow/tfjs`, `@tensorflow/tfjs-core`,
  `@tensorflow/tfjs-backend-cpu`, `@tensorflow/tfjs-backend-webgl`,
  `@tensorflow/tfjs-converter`, `@tensorflow/tfjs-data`, and
  `@tensorflow/tfjs-layers` 4.22.0.
- License: Apache-2.0; see `tfjs/LICENSE`. Portions of
  `@tensorflow/tfjs-layers` are also MIT-licensed; see
  `tfjs-layers/MIT-LICENSE`.

## seedrandom

- Package: `seedrandom` 3.0.5, bundled transitively by TensorFlow.js.
- License: MIT; see `seedrandom/LICENSE`. Its bundled `alea` implementation
  carries a separate MIT notice; see `seedrandom/ALEA-LICENSE`.

## gl-matrix

- Package: `gl-matrix` 3.4.4
- License: MIT; see `gl-matrix/LICENSE.md`.
