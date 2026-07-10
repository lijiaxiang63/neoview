# CLAUDE.md

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

### Region segmentation (segmentation/)

User-drawn regions live in one shared `Uint16Array` label map on the base grid (region id per voxel, mutated in place; `labelMapRev` in the store bumps on every edit to trigger redraws). `segment.ts#segmentRegion` is ONE hysteresis + 3D-connected-component engine behind both methods: Threshold = high==low, seeds = the whole box, flood box-bounded (box surrounds the region); Grow = box entirely *inside* the region, its ≥high interior seeds a flood past the box down to the ≥low boundary, with reach = constraint present → whole volume, else `growMargin` voxels (null = unlimited). Only whole-volume floods carry the `MAX_RESULT_VOXELS` safety cap (`store.ts#floodCap`, reported as `truncated`); when bounds dwarf that cap the flood runs sparse (hash-set visited, tight result bounds) so previewing never allocates whole-volume arrays. Connectivity is 6 or 26; components under `minVoxels` drop during the flood. Constraints are lazy per-voxel predicates (another volume via inlined affine mapping, or an existing region), so an unbounded grow never precomputes an array. Otsu returns the *midpoint of the plateau* of maximal between-class variance (mid-gap on clean bimodal boxes), clamped to `[OTSU_FLOOR, OTSU_CEILING]`. Thresholds live on fixed tuning scales (segment.ts constants: `THRESHOLD_RANGE` 40–100, `GROW_BOUNDARY_RANGE` 40–80, `GROW_SEED_RANGE`, defaults 55/300, fallback 130), independent of the image histogram — the sliders, auto-threshold clamps, and method-switch clamps all read them; grow's seed level auto-seeds from the box mean. The panel plots the box ∩ constraint histogram (`boxHistogram`, computed with each preview) with a vertical marker per threshold. Box creation takes the in-plane drag rect plus a slab-depth setting along the plane's slice axis (`finalizeBox` records the slab axis for the panel's slab input). `regions.ts` holds label-map edits (commit mask, erase+restore for one-step delete undo, brush stroke stamping), per-region stats, slice RGBA extraction, and export remapping/color-table helpers. Preview lifecycle is store-driven: box/param changes debounce (90 ms) into a synchronous recompute; commit assigns the next region id (never reused), consumes the box, and drops the tool back to navigate. Re-edit (`editRegion`, triggered by right-clicking a region on a slice in navigate mode): each commit snapshots its box + parameters (`segSnapshots`), which re-editing restores (fallback: the region's bounding box); the next commit replaces that region's voxels, keeping its identity. The box outline draws only on slices inside its slab range (box tool keeps a faint dashed ghost outside). Double-click in navigate mode maximizes a slice view (`maximizedView`; others stay mounted but hidden so canvases/camera survive; Esc restores). SliceView draws regions above all overlay layers and the preview above that (in the color the region will get); box handles/brush cursor render on the vector overlay canvas. Export (`exportRegions.ts`) serializes via `parse.ts#serializeVolume` (header layout stays in parse.ts), writes with no dialog to the source folder (or the folder picked in export settings, persisted in localStorage), collision-suffixes in the main process, and toasts with reveal-in-file-manager. The file panel folds region exports into the folder list (`files/folderList.ts#regionExportView`, cached per list array): a product (`*.regions.*` / `*.mask.*`, collision suffixes included) sitting beside its source volume is hidden from the list and marks that source's row with a check; the store's session-scoped `exportedPaths` marks rows whose export landed outside the opened folder. The coordinator navigates the same folded list. `segDirty` gates a confirm on base replace and on window close (main holds `close` until the renderer replies on `close-confirmed`).

### 3D view (render3d/)

`raycaster.ts` owns a WebGL2 context: fullscreen triangle from `gl_VertexID` (no VBOs/matrices), ray-box intersection in the fragment shader, R16F 3D texture uploaded as HALF_FLOAT (driver memcpy). MIP and front-to-back composite modes; display window, mode, density, brightness are uniforms only — slider drags never touch texture memory. Volumes over `MAX_TEX_VOXELS` (128 Mi) get per-axis stride downsampling via `planTexture` — physical extents preserved, slice views stay full-res.

Rendering is dirty-flag rAF, never a continuous loop. Interaction renders at quarter step count and half backing-store resolution; a 180 ms settle timer re-arms while the pointer is down and only then renders full quality. Camera (`camera.ts` OrbitCamera) is component-local state in `VolumeView.tsx`, not in the store. Context loss is handled (rebuild from cached data on restore).

### Auto-update (main/update.ts)

Zero-dependency updater against the repo's releases. `updateCheck.ts` is the pure, unit-tested half: numeric version compare vs the latest release tag and per-platform/arch asset pick (dmg / setup.exe / AppImage-then-deb; explicit wrong-arch names are rejected). `update.ts` owns settings (`update-settings.json` in userData: `autoCheck`, `skippedVersion`), the streamed download (temp dir, sha256 digest verify when the API provides one, throttled progress events, abortable; all requests via `net.fetch` so system proxy settings apply), and install hand-off: mac/win quit first — the unsaved-edits close veto still applies — and spawn the installer from `will-quit` so it never races the running app; Linux chmods the file and reveals it. The renderer side is a single `UpdateBanner.tsx` (bottom-right, toast-styled) driven by `update-status`/`update-progress` IPC events; manual check and the auto-check toggle live in the app menu (macOS) / Help menu. Auto-check runs once, 10 s after launch, and is silent unless a new version exists; shared payload types sit in `src/preload/updates.d.ts` (type-only, reachable from all three processes).

### State

`store.ts` (zustand): volume, crosshair, frame, display range `{lo,hi}` shared by 2D and 3D (3D converts via `scaledToNormalized`), render mode/density/brightness (viewing prefs — not reset on file change), preset heuristic on load.

### Tests

Pure logic is deliberately kept out of GL/React so it's unit-testable: parser, affine, stats, normalize/planTexture/floatToHalf, camera basis, store. Fixtures come from `scripts/make-test-volumes.mjs` (`buildVolume` is imported directly by tests; closed-form voxel values). There is no WebGL in the test environment — keep the raycaster thin and push anything computable into `normalize.ts`/`camera.ts`.

## Change completion

For implementation and refactoring requests:

- Do not stop after planning; implement the requested change.
- Run targeted tests during implementation.
- Run the full required verification commands before completion.
- Review the complete diff for regressions, races, lifecycle issues,
  dependency violations, performance changes, and missing tests.
- Fix all actionable findings and rerun verification.
- Repeat review, fix, and verification until no actionable findings remain.
- Do not commit or push unless explicitly requested.
