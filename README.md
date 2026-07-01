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

Requires Node 18+. Zero dependencies.
