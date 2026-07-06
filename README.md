# Hexweave

Browser-based parametric generator for printable [Honeycomb Storage Wall](https://www.printables.com/model/152592-honeycomb-storage-wall) panels.

Design a wall by shape (rectangle, regular polygon, vertex list, SVG, drawing canvas), pick a printer, and the tool tessellates the surface with the standard HSW hex lattice, subdivides oversized walls into plate-sized tiles that interlock via clip inserts, packs the tiles + inserts onto print plates, and exports STL or 3MF (pre-positioned per plate). An optional natural-language agent fills the form from a brief and can run against either the Anthropic API or any local OpenAI-compatible model (Ollama, LM Studio, llama.cpp, vLLM, ...).

**Stack**: Next.js 16 (App Router) + React 19 + Three.js via react-three-fiber. The geometry layer under `src/lib` is framework-agnostic and runs headless from the validation scripts.

> Status: early. Not hosted. Run it locally with `npm run dev`.

## Features

- **Five shape inputs**: rectangle, regular polygon, vertex list, SVG import (`<polygon>` / `<polyline>` / simple `<path>` with M/L/H/V/Z), and an interactive drawing canvas with grid snap.
- **HSW standard locked**: 20 mm flat-to-flat cells, 3.6 mm inter-cell wall (2 × 1.8 mm half-wall per cell, so panel-edge border is 1.8 mm), 8 mm depth, flat-top orientation. Measured against the original `wall-honeycomb-part.stl` and `Insert-countersunk.stl`.
- **Bordered mode keeps the panel at the exact W×H you ask for** (rectangular walls): cells along the inner border are **clipped** to fit instead of being dropped. Set the anti-sliver threshold (% of full hex area below which a clipped cell is dropped — defaults to 25 %) for a uniform, full-rectangle look. Inserts (clip clusters, bridges, wall mounts) never land on partial cells: those are decorative-only.
- **Uniform border** that scales linearly with thickness (mitered outward offset of the cell-trace polygon, used for borderless / non-rect shapes).
- **Subdivision with interlocking tiles**: seams pass through cell centres, producing half-cell indents that recombine into full hexagons when adjacent tiles are placed; clip inserts lock the join.
- **Clip inserts** sized and placed structurally, not uniformly. Each insert crosses its seam perpendicularly so a real grip cell sits in each adjacent tile:
  - *Vertical seam with no horizontal crossing*: 3-cell **horizontal cluster** — full grip cell in left tile, bisected on the seam, full grip cell in right tile.
  - *Vertical seam crossing a horizontal seam (X-junction)*: 6-cell **cross-cluster**. Shape depends on the parity of the seam column:
    - *odd column*: hourglass — two 3-cell triangles (one above the y-seam, one below) joined by a 2-cell spine bisected by the x-seam. All four tiles meeting at the X-junction get a full grip cell.
    - *even column*: hexagonal ring of 6 cells around the (quartered) centre, which is skipped. The flange union is a donut. Four of the six cells are full grip cells, one per tile.
  - The cross-cluster spans both seams in one printed piece, so it locks the four tiles together even with `bridges = 0` — relying purely on the cluster + wall mounts for structural integrity.
  - *Horizontal seams between X-junctions*: 2-cell **bridges** (full above + full below) — the bisected cells on a horizontal seam aren't honeycomb-adjacent in flat-top, so the lock comes from the two full cells either side.
  - Override all counts from the UI (Auto / 0 / 1 / 2 / 3 / 5). Default Auto places one cross-cluster per X-junction, one 3-cell cluster on uncrossed vertical seams, and ~1 bridge every 200 mm of horizontal seam.
  - Geometry: flange (Ø 22.5 mm flat-to-flat, 2 mm protruding out of the panel pocket on the user-facing side) + body (8 mm through the cell) + locking tabs on the WALL-side body tip. Each tab matches the exact silhouette of the original RostaP clip (extracted from `Insert-countersunk.stl` at y=0): a curved leading bevel rising to 0.525 mm protrusion, then a snap-catch shelf that engages the panel rear groove. A tab is dropped on a flat that faces another cluster cell (e.g. the inner spine of a 6-cell hourglass) so it never presses into an adjacent body.
  - **Flange spine** between cells of multi-cell inserts (bridge / cluster). The lattice pitch (23.6 mm) leaves a 1.1 mm gap between adjacent flange hexes (Ø 22.5 mm flat-to-flat); the spine fills the gap in the flange Z range so the insert prints as ONE continuous piece — matching the original RostaP `insert-countersung-m3.stl` / `Insert-countersunk-with-m3x3.stl`.
- **Countersunk wall-mount inserts (M3 / M4 / M5)** with a 3-stage through-hole ordered USER → WALL along the screw axis: Ø10 / Ø12 / Ø14 access well (deep cylinder on the flange / OUTER side, screwdriver enters here) → short 1.5 mm cone narrowing → Ø3.5 / Ø4.5 / Ø5.5 shaft exiting the body tip into the wall. Geometry verified against the original RostaP `Insert-countersunk.stl` (cavity Ø10 at flange-tip face, Ø3.5 at body-tip face). The count is **global** (one number for the whole panel, not per tile): **Auto** = `1` below 200 mm of longest side, otherwise `max(2, ceil(longest_side / 400 mm))` — the structural minimum needed to hang the panel without bending. The user can force a higher count to add perimeter support, or `0` for none.
- **Merge wall mounts into clip clusters** (default on). Wall-mount placement actively snaps onto cluster cells, distributed uniformly across the wall bbox, and the M3 hole is folded into that cell so a single printed part both locks the seam and fixes the panel. Toggle off to keep every wall mount as a standalone piece.
- **Insert variants, per-cell** — every cell of every insert can be one of 9 variants matching the original HSW connector library:
  - `empty` (hex Ø13 cavity, default), `solid` (covered), `hollow` (Ø10 cylinder for hooks),
  - `m3` / `m4` / `m5` (clip with embedded hex nut at the rear of the body: 5.7×2.6 / 7.2×3.4 / 8.2×4.2 mm pocket — the bolt enters through a Ø shaft hole on the flange, threads into the nut),
  - `countersunk-m3` / `-m4` / `-m5` (Ø head pocket on the flange + Ø shaft through the body — the panel screws to the wall here).
  - Two global defaults: one for clip cells, one for wall-mount cells. Per-cell overrides via a collapsible list in the sidebar.
- Both insert kinds ship as separate objects in the STL ZIP / 3MF export, ready to print.
- **Material profile picker** — PETG (RostaP native, no compensation), PLA (+0.15 mm/side), ABS (-0.05 mm/side) or Custom. Drives `cellHoleExpansion` on the panel cell hole (front, rear and pocket) to compensate for shrinkage / over-extrusion so an original RostaP insert (or one printed in a different material) still fits at the design clearance. Insert geometry is never scaled by this setting; leave at PETG when panel and insert share the same material. Persisted in `localStorage` alongside all other settings.
- **Bin-packing** (`maxrects-packer`) on multiple plates with configurable bed and margin; preset list includes Bambu A1 mini / A1 / P1 / X1, Anycubic Kobra S1, Prusa MK4 / MINI, Ender 3, Voron 2.4.
- **Exports**: STL ZIP (one file per tile/insert) or 3MF ZIP (one `.3mf` per plate, items pre-positioned via `<item transform>`); assembly README included.
- **Optional agent** with three modes (chat-config / optimizer / end-to-end) that calls 8 typed tools to drive the form. Provider chosen at startup via env vars (cloud Anthropic or any local OpenAI-compatible endpoint).

## Viewer

The 3D viewer is a full-bleed canvas with floating toolbars (app actions on the left, render options on the right).

- **Three view modes** cycled by the top-right button, with the active mode labelled inline:
  - *Colors* — every tile gets a distinct accent colour and every insert kind a category accent (clip / bridge / mount) — clearest read of what's-what.
  - *Print* — single wall colour + single insert colour, both user-pickable in the **Display** modal (toolbar left). Useful to preview the assembled wall in the filament you actually own.
  - *Exploded* — tiles drift radially from the wall centre, inserts float as a separate layer above — clear "two sections" assembly view.
- **Face toggle** (top-right, below view-mode): the panel's user-facing side has the flange caps protruding outward (their head pockets visible); the wall-facing side has the rear groove and the body-tip locking tabs. The button labels which face is currently up: *Outer face* (default, what you see when the panel is mounted) or *Wall face*.
- **X-ray** and **Section view** (top-right): X-ray makes every mesh translucent for spotting inserts inside the panel; Section provides a horizontal cutting plane with a vertical slider.
- **Camera**: orbit + scroll-wheel zoom, no pan. **Zoom-to-cursor** is on, so the wheel zooms toward the point you're pointing at — drill into a specific cell or insert by hovering it. The camera auto-fits the bounding sphere on every regenerate, so changes in wall size never leave you zoomed into a corner.
- **Settings persist** in `localStorage` (key `hsw-builder:settings:v1`): shape, plate, border, insert counts, variants, per-cell overrides and print colours all survive a page reload. The wall regenerates automatically after restore — no second click needed.

## Quick start

Requires Node 20+ (developed on Node 22 / 24 LTS; `engines.node` in `package.json` enforces the floor).

```bash
git clone https://github.com/scastoldi/hexweave.git
cd hexweave
npm install
npm run dev
```

Open <http://localhost:3000>.

With no `.env.local`, the app runs fully offline and the agent panel is hidden; see [Agent configuration](#agent-configuration-optional) to opt in.

## Docker

Multi-stage image using the Next.js standalone runtime (`output: 'standalone'` in `next.config.ts`). No secrets are baked in; pass agent env vars at run time.

```bash
docker build -t hexweave .
docker run --rm -p 3000:3000 hexweave

# or with compose (reads ANTHROPIC_API_KEY from the shell):
docker compose up -d
```

To enable the agent inside the container, pass the env vars explicitly:

```bash
docker run --rm -p 3000:3000 \
  -e AGENT_ENABLED=true \
  -e AGENT_PROVIDER=anthropic \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  hexweave
```

## Agent configuration (optional)

The agent is **off by default**. Set `AGENT_ENABLED=true` to opt in: until then the agent panel is hidden in the UI and `/api/agent` returns 404. Restart the dev server after editing the env file.

```bash
cp .env.local.example .env.local
# edit .env.local, then restart the dev server
```

### Anthropic (cloud)

```dotenv
AGENT_ENABLED=true
AGENT_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
# ANTHROPIC_MODEL=claude-sonnet-4-6   # optional override
```

### Local / OpenAI-compatible

Any server that speaks OpenAI Chat Completions with tool calling. Works with Ollama, LM Studio, llama.cpp server, vLLM, LocalAI, Together, Groq, OpenRouter.

```dotenv
AGENT_ENABLED=true
AGENT_PROVIDER=openai_compatible
AGENT_BASE_URL=http://localhost:11434/v1
AGENT_MODEL=llama3.1:8b
# AGENT_API_KEY=                        # only for hosted providers like Groq
```

The model must support OpenAI-style tool calling. Llama 3.1 8B / Qwen 2.5 7B / Mistral Nemo are reasonable lower bounds; smaller models will struggle.

When enabled, `GET /api/agent/config` returns the resolved provider and model (no secrets); when disabled it returns `{ "enabled": false }`.

## Available scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Next.js dev server (Turbopack) on port 3000 |
| `npm run build` / `start` | Production build |
| `npm run typecheck` | `tsc --noEmit`, strict TypeScript |
| `npm test` | Vitest integration suite: panel geometry, subdivision, insert placement, export (3MF), arbitrary shapes, agent schemas |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:coverage` | Vitest with V8 coverage report |
| `ORIGINAL_STL_DIR=… npm test -- original-match` | Include the STL-match test (skipped by default; needs original RostaP files locally — CC BY-NC 4.0, not redistributed) |

## Project layout

```text
src/
  app/
    page.tsx                # editor; binds shape, plate, border, agent into one state
    api/agent/
      route.ts              # POST: chat-completions over Anthropic or OpenAI-compatible
      config/route.ts       # GET: provider readiness, no secrets
  components/
    Viewer/                 # R3F canvas, colour-coded tiles + inserts
    ShapeInput/             # tabs for the 5 input methods
    Agent/                  # chat panel + provider badge
  lib/
    hsw/
      constants.ts          # HSW standard + plate presets
      honeycomb.ts          # hex math, cell generation, borderless trace
      geometry.ts           # earcut-based extrusion with holes
      insert.ts             # flange + body + clip-tab insert mesh
    shape/                  # polygon utilities, sides+angles, SVG parser, mitered offset
    subdivision/
      tiler.ts              # center-cut seams, half-cell handling via polygon clipping
      inserts.ts            # one insert per bisected cell
      packer.ts             # maxrects bin-packing onto plates
    export/
      stl.ts                # binary STL writer
      threemf.ts            # 3MF (ZIP + OPC) writer using fflate
      assembly.ts           # JSON assembly map + readable README
    agent/
      tools.ts              # 8 tool schemas for setting form fields
      prompts.ts            # system prompts per mode
      config.ts             # env-driven provider resolution
    three/                  # mesh ops (translate, rotate, concat, recenter)
scripts/                    # standalone validations runnable with tsx
public/
```

The geometry layer is framework-agnostic — `lib/hsw`, `lib/shape`, `lib/subdivision`, `lib/export` have no React or DOM dependency and are exercised directly by the `scripts/*.ts` validators.

## Licensing notes (important)

**The code in this repository is MIT licensed.** See [LICENSE](./LICENSE).

**The HSW geometric standard** (cell size, wall thickness, clip-insert dimensions) was derived from the original *Honeycomb Storage Wall* model by RostaP on Printables, which ships under [Creative Commons Attribution-NonCommercial 4.0](https://creativecommons.org/licenses/by-nc/4.0/). The original STL/STEP files are not redistributed here — only the measured parameters.

Practical consequences:

- Using this tool for personal, non-commercial prints is fine.
- Selling the generated panels or running this tool as part of a paid commercial service is **not** covered by the upstream HSW license. Talk to a lawyer if in doubt about your jurisdiction.
- Forking the code itself for commercial software is fine under MIT, but the geometry it produces is still derived from a CC BY-NC asset.

Attribution to the original creator (RostaP) is appreciated whenever you share generated parts.

## Known gaps and ideas

- **Insert clip details**: the rear tabs are rigid rectangular protrusions; the real spring-clip behaviour from the original STEP isn't modelled yet. Friction-fit works, snap-fit doesn't.
- **Polygon offset miters**: convex 60° corners on a hex trace produce long miter spikes; rounded joins would give a cleaner edge.
- **SVG curves**: only M/L/H/V/Z absolute and relative commands. C/S/Q/T/A are ignored.
- **Draw canvas**: no self-intersection check on the user polygon.
- **Single-turn agent**: each user message is independent. No history is passed back to the model, which keeps prompts short but rules out conversational follow-up like "why did you pick that bed?".

## Acknowledgements

- Original Honeycomb Storage Wall by RostaP on Printables: <https://www.printables.com/model/152592-honeycomb-storage-wall>.
- Inspiration for a parametric web generator: <https://gridfinity.perplexinglabs.com/pr/hsw/0/0>.

## Contributing

PRs welcome. Run `npm run typecheck` and `npm test` before opening one.
