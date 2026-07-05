# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Hard rules

- **Vocabulary**: The only domain-specific tokens allowed anywhere (code, comments, UI copy, docs, commit messages, dependency choices) are the literal file extensions `.nii` / `.nii.gz`, and only in file filters / drop checks. Everything else uses neutral terms: volume, voxel, slice, plane XY/XZ/YZ, axis 0/1/2, intensity, affine, display range. Raw header field names (`sizeof_hdr`, `pixdim`, `srow_x`, …) may appear only inside `src/renderer/src/volume/parse.ts` and its tests — never in UI strings. Do not add third-party parsing/rendering libraries (their names violate the rule); the parser is written from scratch on purpose. Files under `testdata/` may have arbitrary names — reference them via globs, never echo their name parts.
- **GUI verification**: never drive the desktop UI with automation. When a change needs visual verification, hand the user a manual test checklist and let them run `npm run dev`.

## Commands

```bash
npm run dev                          # hot-reload dev app
npm test                             # all unit tests (vitest)
npx vitest run tests/parse.test.ts   # single test file
npm run typecheck                    # node + web tsconfigs
npm run lint                         # eslint (cached)
npm run gen:testdata                 # regenerate synthetic volumes in testdata/
npm run build:mac|build:win|build:linux
```

Benchmark the load pipeline against a real file (auto-skips without the env var):

```bash
REAL_FILE=<path> npx vitest run tests/perf.local.test.ts --disable-console-intercept
```

Electron binary lives in `~/Library/Caches/electron` on macOS; if `npm install` postinstall scripts are blocked, approve them (`electron`, `esbuild`, `electron-winstaller`) and reinstall.

## Architecture

electron-vite three-process layout: `src/main` (window, menu, open-dialog IPC, 2 GiB file guard), `src/preload` (contextBridge exposing `window.neoview`), `src/renderer` (React 19 + zustand). Runtime deps are intentionally minimal — no parsing, math, or rendering libraries.

### Load pipeline (all heavy work off the main thread)

`loadVolume.ts` spawns a fresh module Worker per file (`volume/worker.ts`), which runs:

1. `gunzip.ts` — DecompressionStream; preallocates output using the gzip ISIZE trailer, falls back to chunk accumulation if the trailer lies.
2. `parse.ts` — 348-byte v1 header, both endiannesses via `sizeof_hdr`, datatype table, `scl_slope/inter`, affine priority: matrix rows > quaternion > spacing fallback. Zero-copy typed-array view into the file buffer when little-endian and offset-aligned.
3. `stats.ts` — for ≤2-byte integer types, one exact counting pass (65536 bins) yields min/max/percentiles; float types use a min/max pass + 8192-bin histogram.
4. `normalize.ts#buildTexData` — fused stride-sample + scale + [0,1] normalize + half-float pack for the 3D texture (frame 0).

Results transfer back as Transferables; the prebuilt texture payload rides a WeakMap side-channel (`initialTexOf`, non-consuming so StrictMode double-effects don't rebuild). The main thread pays only the GPU upload.

### Slice views (2D)

`slicing/extract.ts` PLANES table maps each view to {sliceAxis, colAxis, rowAxis} with strides `[1, nx, nx*ny]`. Extraction and windowing are fused into one loop writing packed RGBA via a `Uint32Array` view; canvases letterbox with spacing-corrected aspect and the row axis points up. Wheel = slice scrub (no zoom/pan by design).

### Overlay layers (slicing/overlay.ts)

Ordered list in the store (`overlays[]`, kinds: value map / mask / labels); slice views only — the 3D raycaster never sees them. Alignment is per-layer `M = inv(A_overlay)·A_base` (cached in a WeakMap, `volume/affine.ts#composeVoxelMap`); `extractOverlayRGBA` walks the base slice grid stepping the overlay-space coordinate incrementally (3 adds/pixel, fresh start per row) with nearest-neighbor rounding, so arbitrary grids work. Colors via 256-entry colormap LUTs (warm/cool + diverging 'signed' that windows on |v|), a golden-angle label palette, and one mask color; transparent for out-of-bounds/below-threshold/label-0/NaN. SliceView composites each visible layer's own offscreen canvas over the base with `globalAlpha` = layer opacity (smoothing off for mask/labels). Overlay loads reuse the worker with `skipTex: true` (no 3D texture build); drag&drop routes to a layer whenever a base volume exists, explicit Open always replaces the base (and clears layers).

### 3D view (render3d/)

`raycaster.ts` owns a WebGL2 context: fullscreen triangle from `gl_VertexID` (no VBOs/matrices), ray-box intersection in the fragment shader, R16F 3D texture uploaded as HALF_FLOAT (driver memcpy). MIP and front-to-back composite modes; display window, mode, density, brightness are uniforms only — slider drags never touch texture memory. Volumes over `MAX_TEX_VOXELS` (128 Mi) get per-axis stride downsampling via `planTexture` — physical extents preserved, slice views stay full-res.

Rendering is dirty-flag rAF, never a continuous loop. Interaction renders at quarter step count and half backing-store resolution; a 180 ms settle timer re-arms while the pointer is down and only then renders full quality. Camera (`camera.ts` OrbitCamera) is component-local state in `VolumeView.tsx`, not in the store. Context loss is handled (rebuild from cached data on restore).

### State

`store.ts` (zustand): volume, crosshair, frame, display range `{lo,hi}` shared by 2D and 3D (3D converts via `scaledToNormalized`), render mode/density/brightness (viewing prefs — not reset on file change), preset heuristic on load.

### Tests

Pure logic is deliberately kept out of GL/React so it's unit-testable: parser, affine, stats, normalize/planTexture/floatToHalf, camera basis, store. Fixtures come from `scripts/make-test-volumes.mjs` (`buildVolume` is imported directly by tests; closed-form voxel values). There is no WebGL in the test environment — keep the raycaster thin and push anything computable into `normalize.ts`/`camera.ts`.
