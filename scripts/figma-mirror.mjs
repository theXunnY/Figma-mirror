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

import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
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
  'scrollBehavior', 'interactions', 'complexStrokeProperties',
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
      if (wait > 120) throw new Error(`Figma rate limit: retry allowed in ${Math.round(wait / 3600)}h — API quota exhausted (free-plan monthly caps are low). Wait it out or use a token from a higher plan.`);
      console.log(`  rate limited, waiting ${wait}s...`);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} on ${path}: ${await res.text()}`);
    return res.json();
  }
}

async function download(url, dest, retried = false) {
  const res = await fetch(url).catch(e => { if (retried) throw e; return null; });
  if (!res?.ok) {
    if (retried) throw new Error(`${res?.status ?? 'network error'} downloading ${url}`);
    await new Promise(r => setTimeout(r, 2000));
    return download(url, dest, true);
  }
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
      if (!doc) { console.log(`  warning: "${f.name}" (${f.id}) returned no data — skipped`); continue; }
      const cleaned = clean(doc);
      collectImageRefs(cleaned, allRefs);
      await writeFile(join(dir, 'nodes', `${f.slug}.json`), JSON.stringify(cleaned, null, 1));
    }
    console.log(`  ${batch.length} node trees saved`);
  }

  const renderable = await renderFrames(key, dir, frames);
  await downloadFills(key, dir, allRefs);

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

async function renderFrames(key, dir, frames) {
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
  return renderable;
}

async function downloadFills(key, dir, refs) {
  console.log('downloading image fills...');
  if (!refs.size) { console.log('  none used'); return; }
  const fills = await api(`/files/${key}/images`);
  let n = 0;
  for (const batch of chunk([...refs], 5)) {
    await Promise.all(batch.map(async ref => {
      const url = fills.meta.images[ref];
      if (url) { await download(url, join(dir, 'assets', `${ref}.png`)); n++; }
    }));
  }
  console.log(`  ${n} assets saved`);
}

// Refetch renders + assets for an existing mirror using only the images-tier
// endpoints — they have a separate (much laxer) rate limit than file content,
// so this works even when a full sync is quota-blocked.
async function images(key, dir) {
  const files = (await readdir(join(dir, 'nodes'))).filter(f => f.endsWith('.json'));
  if (!files.length) throw new Error(`no node JSONs in ${dir}/nodes — run a full sync first`);
  const frames = [], refs = new Set();
  for (const f of files) {
    const node = JSON.parse(await readFile(join(dir, 'nodes', f), 'utf8'));
    frames.push({ id: node.id, name: node.name, type: node.type, slug: f.replace(/\.json$/, '') });
    collectImageRefs(node, refs);
  }
  await renderFrames(key, dir, frames);
  await downloadFills(key, dir, refs);
  console.log(`done → ${dir} (renders + assets refreshed from existing node data)`);
}

// ---------- figma-mcp-go bridge (no REST API, no rate limits) ----------
// Talks MCP over stdio to @vkhanhqui/figma-mcp-go, which reads the design
// through a Figma plugin bridge. Requires: Figma Desktop open on the file,
// with the figma-mcp-go plugin running (Plugins → Development → import
// manifest from the repo's plugin.zip).

class McpClient {
  static async start() {
    const proc = spawn('npx -y @vkhanhqui/figma-mcp-go@latest', { shell: true, stdio: ['pipe', 'pipe', 'inherit'] });
    const c = new McpClient(proc);
    await c.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'figma-mirror', version: '1.3.0' },
    }, 90000); // first npx run downloads the package
    c.notify('notifications/initialized');
    return c;
  }

  constructor(proc) {
    this.proc = proc; this.id = 0; this.pending = new Map(); this.buf = '';
    proc.stdout.on('data', d => {
      this.buf += d;
      let nl;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id && this.pending.has(m.id)) {
          const { res, rej, t } = this.pending.get(m.id);
          this.pending.delete(m.id); clearTimeout(t);
          m.error ? rej(new Error(m.error.message)) : res(m.result);
        }
      }
    });
  }

  send(method, params, timeoutMs = 60000) {
    return new Promise((res, rej) => {
      const id = ++this.id;
      const t = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`${method} timed out — is Figma Desktop open with the figma-mcp-go plugin running?`));
      }, timeoutMs);
      this.pending.set(id, { res, rej, t });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method, params = {}) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async call(name, args = {}) {
    const r = await this.send('tools/call', { name, arguments: args });
    if (r.isError) throw new Error(`${name}: ${r.content?.map(c => c.text).join(' ') ?? 'tool error'}`);
    return r.content ?? [];
  }

  // First JSON payload in a tool result, else joined text.
  static text(content) { return content.filter(c => c.type === 'text').map(c => c.text).join('\n'); }
  static json(content) {
    const t = McpClient.text(content);
    try { return JSON.parse(t); } catch { return null; }
  }

  close() { try { this.proc.kill(); } catch { /* gone */ } }
}

// Plugin-API node shapes differ from REST — synthesize the REST-ish fields
// verify.mjs expects (style{}, absoluteBoundingBox) when missing.
function adaptNode(n) {
  if (n === null || typeof n !== 'object') return n;
  const out = { ...n };
  if (n.type === 'TEXT' && !n.style) {
    out.style = {
      fontFamily: n.fontName?.family ?? n.fontFamily,
      fontWeight: n.fontWeight,
      fontSize: n.fontSize,
      letterSpacing: n.letterSpacing?.value ?? n.letterSpacing,
      lineHeightPx: n.lineHeight?.value ?? n.lineHeightPx,
    };
  }
  if (!n.absoluteBoundingBox && n.width != null)
    out.absoluteBoundingBox = { x: n.absoluteX ?? n.x ?? 0, y: n.absoluteY ?? n.y ?? 0, width: n.width, height: n.height };
  if (Array.isArray(n.children)) out.children = n.children.map(adaptNode);
  return out;
}

async function mcpTools() {
  const c = await McpClient.start();
  try {
    const r = await c.send('tools/list', {});
    for (const t of r.tools) console.log(`${t.name}: ${(t.description ?? '').split('\n')[0].slice(0, 90)}`);
    console.log(`\n${r.tools.length} tools`);
  } finally { c.close(); }
}

async function mcpSync(dir) {
  for (const d of ['nodes', 'frames', 'assets']) await mkdir(join(dir, d), { recursive: true });
  const c = await McpClient.start();
  try {
    console.log('connecting to figma via plugin bridge...');
    const meta = McpClient.json(await c.call('get_metadata')) ?? {};
    console.log(`file: ${meta.fileName ?? meta.name ?? 'unknown'}`);
    const pagesInfo = McpClient.json(await c.call('get_pages'));
    const pages = Array.isArray(pagesInfo) ? pagesInfo : pagesInfo?.pages ?? [];
    const startPage = meta.currentPage?.id ?? meta.currentPageId ?? null;
    const seen = new Map();
    let total = 0, shots = 0;

    for (const page of pages.length ? pages : [{ id: null, name: 'current page' }]) {
      if (page.id) {
        try { await c.call('navigate_to_page', { pageId: page.id }); }
        catch (e) { console.log(`  page "${page.name}": ${e.message}`); continue; }
      }
      const doc = McpClient.json(await c.call('get_document'));
      if (!doc) { console.log(`  page "${page.name}": no data`); continue; }
      const kids = doc.children ?? [];
      console.log(`page "${page.name}": ${kids.length} top-level nodes`);
      for (const k of kids) {
        let s = slug(k.name, k.id);
        if (seen.has(s)) s = `${s}-${k.id.replace(/[^0-9]+/g, '-')}`;
        seen.set(s, true);
        await writeFile(join(dir, 'nodes', `${s}.json`), JSON.stringify(clean(adaptNode(k)), null, 1));
        total++;
        try {
          const content = await c.call('get_screenshot', { nodeId: k.id });
          const img = content.find(x => x.type === 'image');
          if (img?.data) {
            const ext = (img.mimeType ?? 'image/png').includes('png') ? 'png' : 'jpg';
            if (ext !== 'png') console.log(`  warning: ${s} exported as ${img.mimeType} — pixel verify needs PNG`);
            await writeFile(join(dir, 'frames', `${s}.${ext}`), Buffer.from(img.data, 'base64'));
            shots++;
          }
        } catch (e) { console.log(`  screenshot ${s}: ${e.message}`); }
      }
    }
    if (startPage) await c.call('navigate_to_page', { pageId: startPage }).catch(() => {});
    console.log(`${total} node trees, ${shots} screenshots saved`);

    try {
      const tokens = McpClient.text(await c.call('export_tokens', { format: 'json' }));
      await writeFile(join(dir, 'tokens.json'), tokens);
      console.log('tokens exported');
    } catch (e) { console.log(`tokens: ${e.message}`); }

    await writeFile(join(dir, 'meta.json'), JSON.stringify({ key: meta.fileKey ?? null, version: null, source: 'figma-mcp-go', synced: new Date().toISOString() }));
    await rebuildIndex(dir, meta.fileName ?? 'figma file');
    console.log(`done → ${dir} (via plugin bridge, zero REST quota used)`);
  } finally { c.close(); }
}

// ---------- offline index rebuild ----------

async function rebuildIndex(dir, title = null) {
  const files = (await readdir(join(dir, 'nodes'))).filter(f => f.endsWith('.json'));
  const rows = [];
  for (const f of files) {
    const node = JSON.parse(await readFile(join(dir, 'nodes', f), 'utf8'));
    const s = f.replace(/\.json$/, '');
    const png = existsSync(join(dir, 'frames', `${s}.png`));
    rows.push(`| ${node.name ?? s} | ${node.type ?? '?'} | nodes/${f} | ${png ? `frames/${s}.png` : '—'} |`);
  }
  await writeFile(join(dir, 'index.md'), [
    `# Figma mirror — ${title ?? 'rebuilt index'}`, '',
    `- rebuilt: ${new Date().toISOString()}`, '',
    'Workflow: look at `frames/<name>.png` first, grep `nodes/<name>.json` for exact values.', '',
    '| Frame | Type | JSON | Image |', '|---|---|---|---|',
    ...rows, '',
  ].join('\n'));
  console.log(`index.md rebuilt (${rows.length} entries)`);
}

async function check(key, dir) {
  const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
  if (meta.version === null) {
    console.log(`mirror came from the plugin bridge (synced ${meta.synced}) — no version tracking; rerun mcp-sync if the design changed`);
    return;
  }
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
else if (cmd === 'mcp-tools') await mcpTools();
else if (cmd === 'mcp-sync') await mcpSync(key ?? 'figma-mirror-data');
else if (cmd === 'index') await rebuildIndex(key ?? 'figma-mirror-data');
else if (['sync', 'check', 'images'].includes(cmd) && key) {
  if (!TOKEN) { console.error('no token: set FIGMA_TOKEN env var or put the token in ~/.figma-token (figma.com → settings → security → personal access tokens)'); process.exit(1); }
  const fns = { sync, check, images };
  await fns[cmd](key.replace(/^.*\/(design|file)\/([a-zA-Z0-9]+).*$/, '$2'), outDir);
} else {
  console.log(`usage: node figma-mirror.mjs <command>
  sync     <file-key-or-url> [out-dir]  full mirror via REST API (needs token)
  check    <file-key-or-url> [out-dir]  staleness check (1 cheap call)
  images   <file-key-or-url> [out-dir]  refresh renders/assets only (works when sync is rate-limited)
  mcp-sync [out-dir]                    mirror all pages via figma-mcp-go plugin bridge (no token, no rate limits)
  mcp-tools                             list bridge tools (debug)
  index    [out-dir]                    rebuild index.md offline from existing nodes
  selftest`);
}
