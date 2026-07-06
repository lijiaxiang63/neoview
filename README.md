# neoview

A cross-platform desktop viewer for `.nii` / `.nii.gz` volumes — tri-planar slicing, 3D raycast rendering, and interactive region segmentation. Built with Electron, React, and TypeScript.

## Features

- **Three synchronized slice views** — planes XY, XZ, and YZ with linked crosshairs; click or drag in any view to move the crosshair, and the other two views follow live
- **Wheel scrubbing** — scroll over a view to step through slices along its axis
- **Drag & drop** — drop a `.nii` or `.nii.gz` file anywhere on the window, or use `Cmd/Ctrl+O`
- **Display range controls** — dual-thumb slider with Auto (2–98 percentile), Full range, and fixed presets; an appropriate preset is chosen automatically on load
- **Cursor readout** — voxel indices, world coordinates (via the affine), and raw/scaled intensity in the status bar
- **GPU volume rendering** — WebGL2 raycaster in the fourth view cell with MIP and composite modes, orbit/dolly camera (drag / wheel / double-click reset), and brightness & density controls; large volumes are automatically stride-downsampled to a texture budget while slice views stay full resolution
- **Overlay layers** — drop additional volumes onto a loaded base to stack value maps (warm/cool/diverging colormaps with a threshold window), binary masks, and label volumes (distinct color per id); layers align through their affines with nearest-neighbor sampling, so differing grids work, and each has its own visibility, opacity, and kind controls
- **4D support** — a frame slider appears for volumes with a fourth dimension
- **Affine panel** — the full 4×4 voxel-to-world matrix, dimensions, spacing, datatype, and which transform source the file provided (matrix rows / quaternion / spacing fallback)
- **From-scratch parser** — no runtime parsing dependencies; handles both endiannesses, all common voxel datatypes, value scaling, and gzip decompression

## Development

```bash
npm install
npm run dev           # start with hot reload
npm test              # parser / affine / extraction unit tests
npm run gen:testdata  # generate synthetic volumes in testdata/
```

The generator writes small synthetic files with closed-form voxel values (`grad_u8.nii`, `sphere_i16_scl.nii`, `grad_f32_4d.nii.gz`, …) so every feature can be verified without external data.

## Packaging

```bash
npm run build:mac    # dmg
npm run build:win    # nsis installer
npm run build:linux  # AppImage + deb
```
