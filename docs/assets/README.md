# Landing-page screenshots

Drop real screenshots here to replace the CSS mockups on the page. Each slot on
`../index.html` has an HTML comment showing exactly what to swap.

| File | What to capture | Best aspect |
|------|-----------------|-------------|
| `icon.svg` / `icon.png` | App icon used by the README, favicon, and social preview metadata | 1:1 |
| `hero.png` | The full window: three slice views + the 3D cell (a loaded volume) | 16:10, wide |
| `slicing.png` | One slice view with the crosshair, corner label, status readout | 16:11 |
| `render3d.png` | The 3D cell alone — MIP or composite, a clear render | 16:11 |
| `overlays.png` | A base slice with a value map + mask (or labels) stacked | 16:11 |
| `segmentation.png` | The segmentation panel: a region highlight + the box + histogram | 16:11 |

Tips:
- Widen the window before capturing so panes are roomy.
- The page background is warm white; dark app screenshots sit inside rounded
  frames with a soft shadow, so edge-to-edge dark UI looks best.
- To use a shot, replace the mock block in `index.html` with, e.g.:
  `<img class="shot" src="assets/hero.png" alt="Neoview main window" />`
- 2× (Retina) captures keep the frames crisp.
