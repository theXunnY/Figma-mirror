---
name: figma-mirror
description: Snapshot a Figma file to local disk once, then build from the local mirror instead of calling Figma/MCP repeatedly. Use when the user shares a Figma link, asks to sync/mirror a Figma design, asks to replicate/implement a Figma design, or when a figma-mirror-data/ folder exists in the project. Saves 70-90% of Figma-related tokens.
---

# figma-mirror

Snapshot a Figma file locally (node trees, frame renders, assets, tokens), then work entirely from disk. Never fetch the same design twice.

The tool is a zero-dependency Node script: `${CLAUDE_PLUGIN_ROOT}/scripts/figma-mirror.mjs`

**Token**: read from `FIGMA_TOKEN` env var or `~/.figma-token` file. If missing, tell the user to create a personal access token at figma.com → Settings → Security → Personal access tokens, and save it: `Set-Content -Path "$HOME\.figma-token" -Value "figd_..." -NoNewline` (PowerShell) or `printf '%s' 'figd_...' > ~/.figma-token` (bash).

## Commands

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/figma-mirror.mjs" sync <figma-url-or-file-key> [out-dir]
node "${CLAUDE_PLUGIN_ROOT}/scripts/figma-mirror.mjs" check <figma-url-or-file-key> [out-dir]
```

- Accepts the full Figma URL (`https://www.figma.com/design/KEY/...`) or the bare file key.
- Default out-dir: `./figma-mirror-data` in the current project.
- `sync` is idempotent — re-running refreshes the mirror.
- `check` is one cheap API call: compares mirror version vs live Figma, says if stale.

## Mirror layout

```
figma-mirror-data/
  index.md            manifest: every page and frame, with paths — READ THIS FIRST
  tokens.md           published styles / design tokens
  meta.json           file key + version (used by check)
  nodes/<frame>.json  cleaned node tree per top-level frame
  frames/<frame>.png  2x render of each frame
  assets/<ref>.png    image fills used in the design
```

## Workflow rules (token discipline)

1. **User shares a Figma link** → run `sync` once, then work only from the mirror.
2. **Mirror already exists** (`figma-mirror-data/` in project) → run `check` at the start of design work. Up to date → do NOT sync again. Stale → tell the user, offer resync.
3. **Understanding a design** → Read the frame PNG first (`frames/<name>.png`). The image answers layout, hierarchy, and visual style far cheaper than JSON.
4. **Exact values** (spacing, hex colors, radii, font sizes) → Grep the frame's `nodes/<name>.json` for the node name, then Read only that region with offset/limit. Never read a node JSON file whole — they can be large.
5. **Design system** → `tokens.md`. If it says no published styles, grep node JSON for `fills`, `style`, `padding`.
6. Never call a Figma MCP server or WebFetch figma.com for data the mirror already has.
7. After a resync, `git diff figma-mirror-data/` (if tracked) shows exactly what the designer changed.

## Verifying the build (no manual devtools)

After implementing a frame, verify against the mirror with `${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs` (zero deps; drives installed Edge/Chrome headless, deterministic rendering: animations off, fonts awaited, 2x scale matching the mirror's exports):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs" verify  <local-url> <frame-slug> [mirror-dir]
node "${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs" snap    <url> [--width N] [--out f.png]
node "${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs" inspect <url> <css-selector> [--width N]
node "${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs" diff    <a.png> <b.png> [--out diff.png]
```

All page-loading commands wait for network idle automatically (SPAs safe). For apps whose content appears late, add `--wait-for "<css-selector>"` to block until that element exists.

Loop until MATCH. One `verify` run reports, in a single pass:
- pixel diff split into **red** (real mismatch) and **yellow** (edge/antialiasing noise — ignore), with heatmap + verdict
- the mismatch bounding box AND the CSS selectors of elements inside it (smallest first — usually the culprit)
- a text-node delta table, build→figma (`"Pay now": font-size 14px→16px, y 99→101`) — matched by text content against the frame's node JSON

So: 1. `verify <url> <slug>` → 2. fix exactly what the delta table / region selectors say (use `inspect` only for non-text elements the table can't match) → 3. re-run `verify`. Repeat until MATCH / NEAR-MATCH.
Report the final verdict + heatmap path to the user — never claim a match without a MATCH/NEAR-MATCH verdict. Yellow-only diffs are font rasterization differences between Figma and browsers; accept them.

## Rate-limit fallback chain

Figma quotas are per-endpoint-tier: file content (`/files/:key`, `/files/:key/nodes`) is expensive and exhausts first; renders/assets (`/images/:key`, `/files/:key/images`) have a separate, laxer budget. On a 429 with a huge retry-after:

1. **Existing mirror?** Keep working from it — that's the whole point. Structural verify works with node JSON alone (degraded mode, no reference PNG needed).
2. **Missing renders/assets only?** `images <file-key> [mirror-dir]` — refetches them from existing node JSONs via the images-tier endpoints, usually still available when full sync is blocked.
3. **Need fresh node data?** Check whether a Figma MCP server is configured (`claude mcp list`); if so, use it to fetch node data as a stopgap — but warn the user it may share the same account quota.
4. **No MCP?** Ask the user whether to install one just for this, noting it may be rate-limited too — or wait for quota reset (the sync error message states the hours).

## Notes

- If the design is confidential, suggest adding `figma-mirror-data/` to `.gitignore`.
- Variables API is Figma-Enterprise-only, so tokens.md relies on published styles; exact values always live in the node JSON.
- Requires Node 18+ (built-in fetch).
