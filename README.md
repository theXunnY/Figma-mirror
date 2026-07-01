# figma-mirror

Claude Code plugin: snapshot a Figma file to local disk once — node trees, frame renders, assets, design tokens — then Claude builds from the mirror instead of calling Figma/MCP again. Cuts Figma-related token use 70–90%.

## Install

From GitHub (after pushing this folder to a repo):

```
/plugin marketplace add theXunnY/figma-mirror
/plugin install figma-mirror@figma-mirror
```

Or from a local folder:

```
/plugin marketplace add C:\path\to\figma-mirror
/plugin install figma-mirror@figma-mirror
```

## Setup (once per machine)

1. Get a personal access token: figma.com → Settings → Security → Personal access tokens.
2. Save it (pick one):
   - PowerShell: `Set-Content -Path "$HOME\.figma-token" -Value "figd_..." -NoNewline`
   - bash: `printf '%s' 'figd_...' > ~/.figma-token`
   - or set a `FIGMA_TOKEN` env var.

Never commit the token. The plugin reads it from outside the repo.

## Use

Paste a Figma link into Claude Code and ask it to sync/mirror/replicate the design — the bundled skill handles the rest. Manual:

```
node scripts/figma-mirror.mjs sync  <figma-url-or-file-key> [out-dir]
node scripts/figma-mirror.mjs check <figma-url-or-file-key> [out-dir]   # staleness check, 1 cheap API call
node scripts/figma-mirror.mjs selftest
```

Output lands in `./figma-mirror-data/`: `index.md` (manifest), `frames/*.png` (2x renders), `nodes/*.json` (cleaned node trees), `assets/*.png` (image fills), `tokens.md` (published styles).

## Verify (design QA without devtools)

`scripts/verify.mjs` drives your installed Edge/Chrome headless (DevTools protocol — no Playwright, no npm installs) with deterministic rendering: animations disabled, fonts awaited, 2x scale matching the mirror's exports. Same page in, same pixels out.

```
node scripts/verify.mjs verify  <local-url> <frame-slug> [mirror-dir]   # full report
node scripts/verify.mjs snap    <url> [--width N] [--out f.png]         # screenshot
node scripts/verify.mjs inspect <url> <css-selector> [--width N]        # computed styles JSON
node scripts/verify.mjs diff    <a.png> <b.png> [--out diff.png]        # pixel diff + heatmap
```

One `verify` run reports: pixel diff split into real mismatches (red) vs antialiasing noise (yellow), the mismatch region with the CSS selectors of elements inside it, and a build→figma style-delta table for every text node (`"Pay now": font-size 14px→16px`). Claude loops verify → fix → verify until MATCH.

Requires Node 18+ (22+ for verify). Zero dependencies.
