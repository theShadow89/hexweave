# Changelog

All notable changes to Hexweave are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-06

Initial public release.

### Added

- Parametric HSW panel generator with five shape inputs: rectangle, regular
  polygon, arbitrary vertex list, SVG import (M/L/H/V/Z commands) and an
  interactive draw canvas with grid snap.
- HSW-standard-locked hex lattice (20 mm flat-to-flat, 3.6 mm inter-cell wall,
  8 mm depth, flat-top). Values measured against the original RostaP
  `wall-honeycomb-part.stl` and `Insert-countersunk.stl`.
- Bordered mode that keeps the panel at the exact W x H requested, clipping
  edge cells with a configurable anti-sliver drop threshold.
- Subdivision into print-bed-sized tiles that interlock via half-cell seams
  through cell centres.
- Structural clip inserts placed per seam:
  - 3-cell horizontal cluster on uncrossed vertical seams,
  - 6-cell cross-cluster (hourglass or hex ring, chosen by column parity) at
    every X-junction,
  - 2-cell bridges spaced ~1 per 200 mm of horizontal seam.
- RostaP-extracted locking-tab silhouette (curved leading bevel + snap-catch
  shelf) applied to insert bodies, with tab suppression on flats facing
  adjacent cluster cells.
- Countersunk wall-mount inserts in M3 / M4 / M5 with a 3-stage through-hole
  (access well, cone, shaft) verified against the original insert. Global
  count with a structural-minimum auto rule.
- Optional merge of wall mounts into clip clusters so one printed part locks
  the seam and fixes the panel.
- Nine per-cell insert variants: `empty`, `solid`, `hollow`, `m3`/`m4`/`m5`
  (embedded nut), `countersunk-m3`/`-m4`/`-m5` (screw pocket).
- Material profile picker (PETG / PLA / ABS / custom) that drives
  `cellHoleExpansion` on the panel cell hole to compensate for
  shrinkage / over-extrusion when panel and insert are printed in different
  materials.
- Bin-packing across plate presets (Bambu A1 mini / A1 / P1 / X1, Anycubic
  Kobra S1, Prusa MK4 / MINI, Ender 3, Voron 2.4) plus a custom plate.
- STL ZIP export (one file per tile/insert) and 3MF ZIP export (one archive
  per plate, items pre-positioned) with an assembly-map README.
- Optional three-mode agent (chat-config / optimizer / end-to-end) over the
  Anthropic API or any OpenAI-compatible provider (Ollama, LM Studio,
  llama.cpp, vLLM, LocalAI, Together, Groq, OpenRouter). Off by default; the
  panel is hidden and `/api/agent` returns 404 until `AGENT_ENABLED=true`.
- R3F viewer with three view modes (Colors / Print / Exploded), face toggle
  (Outer / Wall), X-ray, section slider, orbit + zoom-to-cursor, auto-fit
  on regenerate.
- Settings persisted in `localStorage` (shape, plate, border, insert counts,
  variants, per-cell overrides, colours, material profile).

[Unreleased]: https://github.com/scastoldi/hexweave/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/scastoldi/hexweave/releases/tag/v0.1.0
