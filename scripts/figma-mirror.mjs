#!/usr/bin/env node
// figma-mirror: snapshot a Figma file locally so you never re-fetch it.
//
// Token:   FIGMA_TOKEN env var, or a ~/.figma-token file (personal access
//          token from figma.com → settings → security).
// Usage:   node figma-mirror.mjs sync <file-key-or-url> [out-dir]
//          node figma-mirror.mjs check <file-key-or-url> [out-dir]
//          node figma-mirror.mjs selftest
//
// Output (default ./figma-mirror-data):
//   index.md          manifest: pages, frames, sync version
//   tokens.md         published styles
//   nodes/<frame>.json  cleaned node tree per top-level frame
//   frames/<frame>.png  2x render per frame
//   assets/<ref>.png    image fills used in the design

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const API = 'https://api.figma.com/v1';

function getToken() {
  if (process.env.FIGMA_TOKEN) return process.env.FIGMA_TOKEN;
  try { return readFileSync(join(homedir(), '.figma-token'), 'utf8').trim(); } catch { return null; }
}
const TOKEN = getToken();

// Node fields that bloat JSON without helping code replication.
const DROP = new Set([
  'fillGeometry', 'strokeGeometry', 'vectorNetwork', 'exportSettings',
  'pluginData', 'sharedPluginData', 'absoluteRenderBounds',
]);

function clean(node) {
  if (Array.isArray(node)) return node.map(clean);
  if (node === null || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (DROP.has(k)) continue;
    out[k] = typeof v === 'number' ? Math.round(v * 100) / 100 : clean(v);
  }
  return out;
}

function slug(name, id) {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return s || id.replace(/[^a-z0-9]+/gi, '-');
}

function collectImageRefs(node, refs = new Set()) {
  for (const f of node.fills ?? []) if (f.type === 'IMAGE' && f.imageRef) refs.add(f.imageRef);
  for (const c of node.children ?? []) collectImageRefs(c, refs);
  return refs;
}

async function api(path) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + path, { headers: { 'X-Figma-Token': TOKEN } });
    if (res.status === 429 && attempt < 3) {
      const wait = Number(res.headers.get('retry-after') ?? 10);
      console.log(`  rate limited, waiting ${wait}s...`);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} on ${path}: ${await res.text()}`);
    return res.json();
  }
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} downloading ${url}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function sync(key, dir) {
  for (const d of ['nodes', 'frames', 'assets']) await mkdir(join(dir, d), { recursive: true });

  console.log('fetching file structure...');
  const file = await api(`/files/${key}?depth=2`);
  const frames = [];
  for (const page of file.document.children) {
    for (const child of page.children ?? []) {
      frames.push({ id: child.id, name: child.name, type: child.type, page: page.name, slug: slug(child.name, child.id) });
    }
  }
  // De-dupe slugs by suffixing the node id.
  const seen = new Map();
  for (const f of frames) {
    if (seen.has(f.slug)) f.slug = `${f.slug}-${f.id.replace(/[^0-9]+/g, '-')}`;
    seen.set(f.slug, true);
  }
  console.log(`${file.name} v${file.version} — ${frames.length} top-level nodes on ${file.document.children.length} pages`);

  console.log('fetching node trees...');
  const allRefs = new Set();
  for (const batch of chunk(frames, 10)) {
    const res = await api(`/files/${key}/nodes?ids=${batch.map(f => f.id).join(',')}`);
    for (const f of batch) {
      const doc = res.nodes[f.id]?.document;
      if (!doc) continue;
      const cleaned = clean(doc);
      collectImageRefs(cleaned, allRefs);
      await writeFile(join(dir, 'nodes', `${f.slug}.json`), JSON.stringify(cleaned, null, 1));
    }
    console.log(`  ${batch.length} node trees saved`);
  }

  console.log('rendering frame images...');
  const renderable = frames.filter(f => ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'SECTION'].includes(f.type));
  for (const batch of chunk(renderable, 10)) {
    const res = await api(`/images/${key}?ids=${batch.map(f => f.id).join(',')}&format=png&scale=2`);
    await Promise.all(batch.map(async f => {
      const url = res.images[f.id];
      if (url) await download(url, join(dir, 'frames', `${f.slug}.png`));
    }));
    console.log(`  ${batch.length} frames rendered`);
  }

  console.log('downloading image fills...');
  if (allRefs.size) {
    const fills = await api(`/files/${key}/images`);
    let n = 0;
    for (const batch of chunk([...allRefs], 5)) {
      await Promise.all(batch.map(async ref => {
        const url = fills.meta.images[ref];
        if (url) { await download(url, join(dir, 'assets', `${ref}.png`)); n++; }
      }));
    }
    console.log(`  ${n} assets saved`);
  } else console.log('  none used');

  console.log('fetching published styles...');
  const styles = await api(`/files/${key}/styles`);
  const rows = styles.meta.styles.map(s => `| ${s.name} | ${s.style_type} | ${s.description || ''} |`);
  await writeFile(join(dir, 'tokens.md'), [
    `# Design tokens — ${file.name}`, '',
    rows.length
      ? ['| Name | Type | Description |', '|---|---|---|', ...rows].join('\n')
      : '_No published styles in this file. Exact values (colors, spacing, type) live in nodes/*.json — grep for `fills`, `style`, `paddingLeft` etc._',
    '',
  ].join('\n'));

  const byPage = {};
  for (const f of frames) (byPage[f.page] ??= []).push(f);
  await writeFile(join(dir, 'index.md'), [
    `# Figma mirror — ${file.name}`, '',
    `- file key: \`${key}\``,
    `- version: \`${file.version}\``,
    `- last modified: ${file.lastModified}`,
    `- synced: ${new Date().toISOString()}`, '',
    'Workflow: look at `frames/<name>.png` first, grep `nodes/<name>.json` for exact values, check `tokens.md` for the design system.', '',
    ...Object.entries(byPage).flatMap(([page, fs]) => [
      `## ${page}`, '',
      '| Frame | Type | JSON | Image |', '|---|---|---|---|',
      ...fs.map(f => `| ${f.name} | ${f.type} | nodes/${f.slug}.json | ${renderable.includes(f) ? `frames/${f.slug}.png` : '—'} |`),
      '',
    ]),
  ].join('\n'));

  await writeFile(join(dir, 'meta.json'), JSON.stringify({ key, version: file.version, synced: new Date().toISOString() }));
  console.log(`done → ${dir}`);
}

async function check(key, dir) {
  const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
  const live = await api(`/files/${key}?depth=1`);
  if (live.version === meta.version) console.log(`up to date (v${meta.version}, synced ${meta.synced})`);
  else console.log(`STALE: mirror has v${meta.version} (synced ${meta.synced}), Figma is at v${live.version} — run sync`);
}

function selftest() {
  const dirty = {
    name: 'Btn', absoluteRenderBounds: { x: 1 }, fillGeometry: [{}], pluginData: { a: 1 },
    cornerRadius: 7.9999999,
    fills: [{ type: 'IMAGE', imageRef: 'abc' }],
    children: [{ name: 'label', vectorNetwork: {}, fills: [{ type: 'SOLID' }] }],
  };
  const c = clean(dirty);
  console.assert(!('absoluteRenderBounds' in c) && !('fillGeometry' in c) && !('pluginData' in c), 'junk dropped');
  console.assert(!('vectorNetwork' in c.children[0]), 'junk dropped recursively');
  console.assert(c.cornerRadius === 8, 'numbers rounded');
  console.assert(c.children[0].name === 'label', 'children kept');
  console.assert([...collectImageRefs(c)].join() === 'abc', 'image refs collected');
  console.assert(slug('Checkout / Final v2!', '1:23') === 'checkout-final-v2', 'slug');
  console.assert(slug('***', '1:23') === '1-23', 'slug fallback');
  console.log('selftest ok');
}

const [cmd, key, outDir = 'figma-mirror-data'] = process.argv.slice(2);
if (cmd === 'selftest') selftest();
else if ((cmd === 'sync' || cmd === 'check') && key) {
  if (!TOKEN) { console.error('no token: set FIGMA_TOKEN env var or put the token in ~/.figma-token (figma.com → settings → security → personal access tokens)'); process.exit(1); }
  await (cmd === 'sync' ? sync : check)(key.replace(/^.*\/(design|file)\/([a-zA-Z0-9]+).*$/, '$2'), outDir);
} else {
  console.log('usage: node figma-mirror.mjs sync|check <file-key-or-url> [out-dir]\n       node figma-mirror.mjs selftest');
}
