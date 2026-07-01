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

## Notes

- If the design is confidential, suggest adding `figma-mirror-data/` to `.gitignore`.
- Variables API is Figma-Enterprise-only, so tokens.md relies on published styles; exact values always live in the node JSON.
- Requires Node 18+ (built-in fetch).
