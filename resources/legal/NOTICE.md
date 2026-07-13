# Third-party notices

## FreeSurfer color table

- Bundled file: `FreeSurferColorLUT.txt`, copied without modification from FreeSurfer 8.1.0.
- License: MGH Software License; see `freesurfer/LICENSE`.
- Required notice: All or portions of this licensed product (such portions are the
  “Software”) have been obtained under license from The General Hospital Corporation
  and are subject to the terms and conditions in that license.

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

## Bundled statistical atlases

Each atlas is bundled as a `.nii.gz` label volume plus a same-stem `.csv` name
table and used only to annotate correction cluster reports with region names.
The files are copied from CAT12 revision
`b4f8ca5070bb08bd25ddcd84134dfe06e77ab5c3`, directory
`templates_MNI152NLin2009cAsym/`. CAT12 is distributed under GPL-2.0-or-later;
the source-specific terms and requested citations below also apply.

- `aal3` — Automated Anatomical Labelling atlas 3. License: GNU General Public
  License. Cite Rolls, Huang, Lin, Feng & Joliot (2020), _NeuroImage_
  206:116189, and Tzourio-Mazoyer et al. (2002), _NeuroImage_ 15:273-289.
- `suit` — SUIT cerebellar atlas. License: Creative Commons
  Attribution-NonCommercial 3.0 Unported. Cite Diedrichsen et al. (2009),
  _NeuroImage_ 46(1):39-46. Labels 29–34 in the name table are supplemented
  from `Diedrichsen_2009/atl-Anatom.lut` at cerebellar-atlases revision
  `1b62fdc0954d34ed768ec36e81ce6a007dbe9e3c`; the CAT12 table omitted those
  names although its label volume contains their values.
- `thalamic_nuclei` — Copyright © 2021 Manojkumar Saranathan, University of
  Arizona, Tucson. License: Creative Commons Attribution 4.0 International.
  Cite Su et al. (2019), _NeuroImage_ 194:272-282, and Saranathan et al. (2021),
  _Scientific Data_ 8:275. This atlas has not been tested or validated for
  clinical use.
- `Tian_Subcortex_S4_7T` — Melbourne Subcortex Atlas (scale IV, 7T). Permission
  is granted to use, copy, modify, merge, publish, and distribute the atlas,
  provided that publications using it cite Tian, Margulies, Breakspear &
  Zalesky (2020), _Nature Neuroscience_ 23:1421-1432.
- `neuromorphometrics` — License: Creative Commons Attribution-NonCommercial
  (no end date). Credit the scans as originating from the OASIS project and the
  labelled data as “provided by Neuromorphometrics, Inc. under academic
  subscription”; include those references in workshop and final publications.
