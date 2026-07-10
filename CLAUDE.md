# CLAUDE.md

## Hard rules

- **Vocabulary**: The only domain-specific tokens allowed anywhere (code, comments, UI copy, docs, commit messages, dependency choices) are the literal file extensions `.nii` / `.nii.gz`, and only in file filters / drop checks. Everything else uses neutral terms: volume, voxel, slice, plane XY/XZ/YZ, axis 0/1/2, intensity, affine, display range. Raw header field names (`sizeof_hdr`, `pixdim`, `srow_x`, …) may appear only inside `src/renderer/src/volume/parse.ts` and its tests — never in UI strings. Do not add third-party parsing/rendering libraries (their names violate the rule); the parser is written from scratch on purpose. Files under `testdata/` may have arbitrary names — reference them via globs, never echo their name parts.
- **GUI verification**: never drive the desktop UI with automation. When a change needs visual verification, hand the user a manual test checklist and let them run `npm run dev`.

## Commands

```bash
npm run dev                          # hot-reload dev app
npm test                             # all unit tests (vitest)
npx vitest run tests/parse.test.ts   # single test file
npx vitest run tests/store.test.ts --sequence.shuffle --sequence.seed=1
npm run typecheck                    # node + web tsconfigs
npm run lint                         # eslint (cached)
npm run build                        # typecheck + production bundles
npm run gen:testdata                 # regenerate synthetic volumes in testdata/
npm run build:mac|build:win|build:linux
```

Benchmark the load pipeline against a real file (auto-skips without the env var):

```bash
REAL_FILE=<path> npx vitest run tests/perf.local.test.ts --disable-console-intercept
```

Electron binary lives in `~/Library/Caches/electron` on macOS; if `npm install` postinstall scripts are blocked, approve them (`electron`, `esbuild`, `electron-winstaller`) and reinstall.

## Architecture

electron-vite three-process layout. `src/main/index.ts` owns app/window/menu/recent-file lifecycle and composes the file and update services. `src/main/files/` owns file dialogs, guarded reads, folder scans, export writes, per-window access, and their disposable IPC registration. `src/preload` exposes the narrow `window.neoview` contextBridge. `src/shared/` contains pure payload contracts shared by all processes and imports no Electron/DOM/React code. `src/renderer` is React 19 + zustand. Runtime deps are intentionally minimal — no parsing, math, or rendering libraries.

### Main file services and process contracts

`src/shared/files.ts` is the single source for open/scan/export and file-panel payloads; `src/shared/updates.ts` does the same for update status/progress/install payloads. Main, preload, and renderer import these contracts instead of redeclaring them.

`src/main/files/reader.ts` enforces the 2 GiB guard before reading and returns exact `ArrayBuffer` spans. `scanner.ts` owns recursive scan limits, bounded directory-read concurrency, and streamed batches. `exports.ts` validates output names, chooses collision suffixes, and writes the optional companion file. `dialogs.ts` keeps paths selected by the user on the main side. `names.ts` is the shared main-side file filter.

`FileAccessAuthorizer` in `access.ts` scopes folder-read access by `webContents.id` and monotonic scan request. A new root activates immediately before its first batch crosses IPC; confirmation makes it the rollback target, cancellation restores the prior confirmed root, and navigation/process loss/window destruction releases access. Reads resolve real paths and validate true containment, so similar prefixes and symbolic-link escapes do not pass. `registerFileIpc` in `ipc.ts` installs every file channel as one unit, tracks senders/pending scans, rolls back partial registration failures, and returns an idempotent disposer.

### Renderer runtime and state ownership

`runtime/RuntimeRoot.tsx` is the composition root outside the StrictMode-stress-mounted view tree. It creates one `RendererRuntime`, injects the store/bridge/window/document/load/alignment/confirm dependencies, calls `init()` in a layout effect, and always calls `dispose()`.

`runtime/rendererRuntime.ts` owns the `LoadCoordinator`, folder-flow re-entry guard, main-process bridge subscriptions, store-to-menu synchronization, global keyboard routing, close confirmation, drag/drop routing, and its small external UI snapshot. It has no import-time registration: every IPC/store/window resource is acquired by `init()` and released by idempotent `dispose()`. Async work is generation-guarded, and coordinator disposal releases queued navigation/prefetch state. `runtime/appEvents.ts` holds the DOM-free decisions for input classification, error cleanup, file/drop routing, shortcuts, menu history, view-menu snapshots, and discard warnings. `App.tsx` only selects render state and composes the view tree through stable runtime entry points.

### Load pipeline (all heavy work off the main thread)

`loadVolume.ts` spawns a fresh module Worker per file (`volume/worker.ts`), which runs:

1. `gunzip.ts` — DecompressionStream; preallocates output using the gzip ISIZE trailer, falls back to chunk accumulation if the trailer lies.
2. `parse.ts` — 348-byte v1 header, both endiannesses via `sizeof_hdr`, datatype table, `scl_slope/inter`, affine priority: matrix rows > quaternion > spacing fallback. Zero-copy typed-array view into the file buffer when little-endian and offset-aligned.
3. `stats.ts` — for ≤2-byte integer types, one exact counting pass (65536 bins) yields min/max/percentiles; float types use a min/max pass + 8192-bin histogram.
4. `normalize.ts#buildTexData` — fused stride-sample + scale + [0,1] normalize + half-float pack for the 3D texture (frame 0).

Results transfer back as Transferables; the prebuilt texture payload rides a WeakMap side-channel (`initialTexOf`, non-consuming so StrictMode double-effects don't rebuild). The main thread pays only the GPU upload.

### Slice views (2D)

`slicing/extract.ts` PLANES table maps each view to {sliceAxis, colAxis, rowAxis} with strides `[1, nx, nx*ny]`. Extraction and windowing are fused into one loop writing packed RGBA via a `Uint32Array` view.

Slice ownership is deliberately split. `slicing/viewport.ts` is DOM-free spacing-corrected letterbox/coordinate/box-handle geometry with the row axis pointing up. `slicing/sliceGestures.ts` is the pure create/move/resize box state machine. `components/useSliceViewport.ts` owns ResizeObserver/canvas sizing; `components/useSliceGestures.ts` owns pointer capture, wheel scrubbing, hover, navigate/brush/box gestures, rAF coalescing, and cancellation cleanup. `slicing/sliceRasterRenderer.ts` owns and disposes base/layer/region/preview canvases and ImageData caches, drawing in semantic layer order while preserving smoothing/opacity rules. `slicing/drawAnnotations.ts` draws the crosshair, box/handles, and brush cursor on the vector canvas. `SliceView.tsx` is the thin store-selection and two-canvas composition layer. Wheel = slice scrub (no zoom/pan by design).

### Overlay layers (slicing/overlay.ts)

Ordered list in the store (`overlays[]`, kinds: value map / mask / labels); slice views only — the 3D raycaster never sees them. Alignment is per-layer `M = inv(A_overlay)·A_base` (cached in a WeakMap, `volume/affine.ts#composeVoxelMap`); `extractOverlayRGBA` walks the base slice grid stepping the overlay-space coordinate incrementally (3 adds/pixel, fresh start per row) with nearest-neighbor rounding, so arbitrary grids work. Colors via 256-entry colormap LUTs (warm/cool + diverging 'signed' that windows on |v|), a golden-angle label palette, and one mask color; transparent for out-of-bounds/below-threshold/label-0/NaN. `SliceRasterRenderer` composites each visible layer's cached offscreen canvas over the base with `globalAlpha` = layer opacity (smoothing off for mask/labels), then regions and preview; removed layers and view disposal release their caches. Overlay loads reuse the worker with `skipTex: true` (no 3D texture build); drag&drop routes to a layer whenever a base volume exists, explicit Open always replaces the base (and clears layers).

### Region segmentation (segmentation/)

User-drawn regions live in one shared `Uint16Array` label map on the base grid (region id per voxel, mutated in place; `labelMapRev` in the store bumps on every edit to trigger redraws). `segment.ts#segmentRegion` is ONE hysteresis + 3D-connected-component engine behind both methods: Threshold = high==low, seeds = the whole box, flood box-bounded (box surrounds the region); Grow = box entirely *inside* the region, its ≥high interior seeds a flood past the box down to the ≥low boundary, with reach = constraint present → whole volume, else `growMargin` voxels (null = unlimited). Only whole-volume floods carry the `MAX_RESULT_VOXELS` safety cap (`store.ts#floodCap`, reported as `truncated`); when bounds dwarf that cap the flood runs sparse (hash-set visited, tight result bounds) so previewing never allocates whole-volume arrays. Connectivity is 6 or 26; components under `minVoxels` drop during the flood. Constraints are lazy per-voxel predicates (another volume via inlined affine mapping, or an existing region), so an unbounded grow never precomputes an array. Otsu returns the *midpoint of the plateau* of maximal between-class variance (mid-gap on clean bimodal boxes), clamped to `[OTSU_FLOOR, OTSU_CEILING]`. Thresholds live on fixed tuning scales (segment.ts constants: `THRESHOLD_RANGE` 40–100, `GROW_BOUNDARY_RANGE` 40–80, `GROW_SEED_RANGE`, defaults 55/300, fallback 130), independent of the image histogram — the sliders, auto-threshold clamps, and method-switch clamps all read them; grow's seed level auto-seeds from the box mean. The panel plots the box ∩ constraint histogram (`boxHistogram`, computed with each preview) with a vertical marker per threshold. Box creation takes the in-plane drag rect plus a slab-depth setting along the plane's slice axis (`finalizeBox` records the slab axis for the panel's slab input); the pure geometry/state machine lives in `slicing/viewport.ts` and `slicing/sliceGestures.ts`, while `useSliceGestures` applies store actions and guarantees stroke/box cleanup across pointer-up, cancellation, capture loss, and unmount. `regions.ts` holds label-map edits (commit mask, erase+restore for one-step delete undo, brush stroke stamping), per-region stats, slice RGBA extraction, and export remapping/color-table helpers. Preview lifecycle is store-driven: box/param changes debounce (90 ms) into a synchronous recompute; commit assigns the next region id (never reused), consumes the box, and drops the tool back to navigate. Re-edit (`editRegion`, triggered by right-clicking a region on a slice in navigate mode): each commit snapshots its box + parameters (`segSnapshots`), which re-editing restores (fallback: the region's bounding box); the next commit replaces that region's voxels, keeping its identity. The box outline draws only on slices inside its slab range (box tool keeps a faint dashed ghost outside). Double-click in navigate mode maximizes a slice view (`maximizedView`; others stay mounted but hidden so canvases/camera survive; Esc restores). `SliceRasterRenderer` draws regions above all overlay layers and preview above that; `drawSliceAnnotations` renders box handles and the brush cursor on the vector canvas. Export (`exportRegions.ts`) serializes via `parse.ts#serializeVolume` (header layout stays in parse.ts), writes with no dialog to the source folder (or the folder picked in export settings, persisted in localStorage), collision-suffixes in the main process, and toasts with reveal-in-file-manager. The file panel folds region exports into the folder list (`files/folderList.ts#regionExportView`, cached per list array): a product (`*.regions.*` / `*.mask.*`, collision suffixes included) sitting beside its source volume is hidden from the list and marks that source's row with a check; the store's session-scoped `exportedPaths` marks rows whose export landed outside the opened folder. The coordinator navigates the same folded list. `segDirty` gates a confirm on base replace and on window close (main holds `close` until the renderer replies on `close-confirmed`).

### 3D view (render3d/)

`types.ts` owns the pure `RenderMode`/`Quality` contracts shared by the store, scheduler, controller, and raycaster. `raycaster.ts` owns only WebGL2 resources and drawing: fullscreen triangle from `gl_VertexID` (no VBOs/matrices), ray-box intersection in the fragment shader, and an R16F 3D texture uploaded as HALF_FLOAT (driver memcpy). MIP and front-to-back composite modes; display window, mode, density, brightness are render state only — slider drags never touch texture memory. Volumes over `MAX_TEX_VOXELS` (128 Mi) get per-axis stride downsampling via `planTexture` — physical extents preserved, slice views stay full-res.

`renderScheduler.ts` owns dirty-flag rAF coalescing (never a continuous loop), capped DPR, interactive half backing-store resolution, full-quality restoration, and the generation-guarded 180 ms settle timer. Dragging gates full quality even when timers or rAF callbacks arrive late; its browser clocks and render callbacks are injected for pure tests. `volumeViewController.ts` owns the Raycaster and OrbitCamera, texture plan and reusable frame/label staging, worker-built frame 0 reuse, explicit display/render/region synchronization, the generation-guarded 200 ms label debounce, unsupported reporting, and current-state context restoration. Context restore recreates GL resources in the raycaster, then the controller reapplies the current volume/frame, camera, render settings, region LUT/opacity, label data, canvas size, and full render request; dispose makes every late callback a no-op.

`components/useVolumeRenderer.ts` is the React adapter. Its `VolumeRendererLifecycle` owns controller mount/dispose, ResizeObserver/window resize, native wheel listener, and the idempotent pointer capture/up/cancel/lost-capture path; large volume/frame synchronization stays in a passive effect. `VolumeView.tsx` contains only exact store selectors, the hook call, and JSX/visible state.

### Auto-update (main/update.ts)

Zero-dependency updater against the repo's releases. `updateCheck.ts` is the pure, unit-tested half: numeric version compare vs the latest release tag and per-platform/arch asset pick (dmg / setup.exe / AppImage-then-deb; explicit wrong-arch names are rejected). `update.ts` owns settings (`update-settings.json` in userData: `autoCheck`, `skippedVersion`), the streamed download (temp dir, sha256 digest verify when the API provides one, throttled progress events, abortable; all requests via `net.fetch` so system proxy settings apply), and install hand-off: mac/win quit first — the unsaved-edits close veto still applies — and spawn the installer from `will-quit` so it never races the running app; Linux chmods the file and reveals it. The renderer side is `UpdateNotif.tsx` (bottom-right, toast-styled), driven by `update-status`/`update-progress` IPC events; manual check and the auto-check toggle live in the app menu (macOS) / Help menu. Auto-check runs once, 10 s after launch, and is silent unless a new version exists; shared payload types live in `src/shared/updates.ts`.

### State

`store.ts` (zustand) keeps the existing bound-hook API but is constructed by `createAppStore(deps)`. Each instance owns its preview controller, timers, pagehide preference flush, subscriptions, transient ids, and brush/preview gesture state; idempotent `dispose()` flushes preferences, cancels timers, invalidates pending previews, terminates the worker, removes pagehide, and unsubscribes listeners. Tests create isolated stores with injected storage/pagehide/timers/preview controllers; `store.ts` exports one runtime singleton and disposes it on hot replacement. State includes volume, crosshair, frame, display range `{lo,hi}` shared by 2D and 3D (3D converts via `scaledToNormalized`), render mode/density/brightness (viewing prefs — not reset on file change), file/folder state, overlays, regions/history/preview, notifications, and the load preset heuristic.

### Tests

Pure logic is deliberately kept out of GL/React so it's unit-testable: parser, affine, stats, normalize/planTexture/floatToHalf, camera basis, 3D render scheduling/controller/lifecycle adapters, isolated store lifecycle, folder coordination, main file services/access/IPC disposal, renderer runtime/app-event routing, slice viewport/box gestures, raster cache ownership, annotation drawing, and pointer-gesture cleanup. `tests/renderScheduler.test.ts`, `tests/volumeViewController.test.ts`, and `tests/useVolumeRenderer.test.ts` use injected clocks, renderers, observers, and elements to cover quality transitions, texture/state synchronization, context restore, StrictMode-style replay, and late-callback cleanup without real WebGL or DOM. Fixtures come from `scripts/make-test-volumes.mjs` (`buildVolume` is imported directly by tests; closed-form voxel values). There is no WebGL in the test environment — keep the raycaster thin and push anything computable into `normalize.ts`/`camera.ts`; canvas-facing modules use injected/fake factories and contexts instead of a desktop GUI.

## Change completion

For implementation and refactoring requests:

- Do not stop after planning; implement the requested change.
- Run targeted tests during implementation.
- Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` before completion.
- Run new/affected tests with shuffled order and multiple fixed seeds when test isolation is relevant.
- Review the complete diff for regressions, races, lifecycle issues,
  dependency violations, performance changes, and missing tests.
- Fix all actionable findings and rerun verification.
- Repeat review, fix, and verification until no actionable findings remain.
- Do not commit or push unless explicitly requested.

For substantial implementation/refactoring work, use two independent read-only review subagents after the first green verification pass when subagent tooling is available and the user has not opted out:

- The main agent is the only writer; reviewers never edit files or split implementation work.
- Give the reviewers different lanes (for example architecture/lifecycle and behavior/tests/performance) and the same stable diff. Their initial reviews are independent.
- Require prioritized findings with file/line evidence, or an explicit "no actionable findings" result.
- The main agent validates findings, fixes confirmed issues, reruns targeted and full verification, then sends the updated diff back to the same reviewers.
- Repeat until both reviewers report no actionable findings. If subagent tooling is unavailable, say so rather than claiming an independent review occurred.
