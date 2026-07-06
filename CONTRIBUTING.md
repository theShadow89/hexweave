# Contributing to Hexweave

Thanks for considering a contribution. Hexweave is a small, deliberately scoped tool: parametric HSW panel generation in the browser. The goal is to keep the codebase auditable end-to-end (geometry + UI + export under ~5k LOC). Please open an issue before sending a non-trivial PR so we can discuss scope.

## Quick start

```bash
git clone https://github.com/scastoldi/hexweave.git
cd hexweave
npm install
npm run dev
```

The geometry layer (`src/lib/hsw`, `src/lib/shape`, `src/lib/subdivision`, `src/lib/export`) is framework-agnostic and is exercised directly by the validation scripts. No browser needed for those.

## Before opening a PR

Run the same checks CI runs:

```bash
npm run typecheck
npm test          # Vitest integration suite (panel / subdivision / export / shapes / agent)
npm run build
```

For geometry changes, additionally run the STL-match test locally against
your copy of the original RostaP files (CC BY-NC 4.0, not redistributed):

```bash
ORIGINAL_STL_DIR=~/Downloads/honeycomb-storage-wall-model_files \
  npm test -- original-match
```

All must pass.

## Geometry changes

If you touch anything under `src/lib/hsw/`, `src/lib/subdivision/` or `src/lib/export/`:

- **Watertight is non-negotiable.** Every mesh produced must have every edge shared by exactly two triangles. The validation scripts already enforce this on the reference cases (rectangle, L-shape, regular polygon, triangle, pentagon). Add a case to the relevant script if your change exercises a new path.
- **Don't change the HSW standard constants.** `HSW_STANDARD` (20 mm inner flat-to-flat, 3.6 mm inter-cell wall = 2 × 1.8 mm half-wall, 8 mm depth, flat-top) is locked because every generated panel has to clip-fit the original HSW inserts. If you're convinced a change is justified, open an issue first.
- **Preserve the reference**: `tests/panel.test.ts` produces a tile that should match the original `wall-honeycomb-part.stl` bbox (170.3 × 177 × 8 mm) with 42 cells (per the measured original STL under the correct 3.6 mm inter-cell wall). The watertightness result is the part that must stay green.
- **Match the original STL**: `tests/original-match.test.ts` checks the generated panel and insert against the original RostaP STL files (must be placed under `~/Downloads/honeycomb-storage-wall-model_files/` or point `ORIGINAL_STL_DIR` at your copy). It's the strictest check — if you touch panel or insert geometry, this is the one that has to stay green.

## Agent changes

If you add or change agent tools (`src/lib/agent/tools.ts`):

- Make the tool name and description self-explanatory. The agent picks tools from short user prompts; vague descriptions degrade end-to-end mode quality.
- Add a default-case branch in `handleAgentTool` in `src/app/page.tsx` if you add a new tool.
- Run `npm run validate:agent` to catch missing/short descriptions.

## Style

- No formatter / ESLint configured. Match surrounding style.
- No emojis in code or comments.
- Comments only when the *why* is non-obvious (a constraint, an invariant, a workaround). Don't restate what the code already says.
- TypeScript strict; no `any` without a written justification.

## Licensing

Code contributions are accepted under MIT (see [LICENSE](./LICENSE)). The HSW geometric standard the tool implements is CC BY-NC 4.0 upstream (see README "Licensing notes"); contributions must not extend the tool in a way that violates that upstream license. When in doubt, ask in the issue.
