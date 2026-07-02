#!/usr/bin/env node
// verify: deterministic design verification against a figma-mirror.
// Zero npm deps — drives installed Edge/Chrome over the DevTools protocol
// (Node 18+ fetch, Node 22+ WebSocket), decodes/encodes PNG via node:zlib.
//
// Usage:
//   node verify.mjs snap    <url> [--width 1440] [--out build.png]
//   node verify.mjs inspect <url> <css-selector> [--width 1440]
//   node verify.mjs diff    <a.png> <b.png> [--out diff.png]
//   node verify.mjs verify  <url> <frame-slug> [mirror-dir]
//   node verify.mjs selftest
//
// Rendering is deterministic: animations/transitions disabled, fonts awaited,
// double-rAF settle, deviceScaleFactor=2 (matches figma-mirror 2x exports),
// scrollbars hidden. Same page in, same pixels out.

import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, rm, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import zlib from 'node:zlib';

// ---------- PNG codec (8-bit RGB/RGBA, non-interlaced) ----------

function pngDecode(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, w, h, colorType, bitDepth, interlace, idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || ![2, 6].includes(colorType) || interlace) throw new Error(`unsupported PNG variant (depth ${bitDepth}, color ${colorType}, interlace ${interlace}) — re-export as plain RGB/RGBA`);
  const bpp = colorType === 6 ? 4 : 3, stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h * 4, 255);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + b) & 255;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      row[x] = v;
    }
    prev = row;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, i = x * bpp;
      out[o] = row[i]; out[o + 1] = row[i + 1]; out[o + 2] = row[i + 2];
      if (bpp === 4) out[o + 3] = row[i + 3];
    }
  }
  return { width: w, height: h, data: out };
}

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = buf => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function pngEncode(w, h, data) {
  const stride = w * 4, raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const chunk = (type, d) => {
    const b = Buffer.alloc(12 + d.length);
    b.writeUInt32BE(d.length, 0); b.write(type, 4); d.copy(b, 8);
    b.writeUInt32BE(crc32(b.subarray(4, 8 + d.length)), 8 + d.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- pixel diff ----------

function pixelDiff(a, b) {
  const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
  const out = Buffer.alloc(w * h * 4);
  const px = (img, x, y) => { const i = (y * img.width + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
  const near = (p, q) => Math.abs(p[0] - q[0]) <= 32 && Math.abs(p[1] - q[1]) <= 32 && Math.abs(p[2] - q[2]) <= 32;
  const cols = Math.ceil(w / 32), cells = new Map();
  let bad = 0, aa = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const pa = px(a, x, y), pb = px(b, x, y), io = (y * w + x) * 4;
    out[io + 3] = 255;
    if (near(pa, pb)) { // faded grayscale of the reference so mismatches pop
      const g = (pa[0] * 0.3 + pa[1] * 0.6 + pa[2] * 0.1) | 0;
      const v = 255 - ((255 - g) >> 2);
      out[io] = v; out[io + 1] = v; out[io + 2] = v;
      continue;
    }
    // Sub-pixel edge shift (antialiasing): each image has a nearby pixel
    // matching the other's center — text edges and rounding, not a real
    // mismatch. Radius 2 (device px = 1 CSS px at 2x) absorbs the difference
    // between Figma's and the browser's font rasterizers.
    let shiftA = false, shiftB = false;
    outer: for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (!shiftA && near(px(a, nx, ny), pb)) shiftA = true;
      if (!shiftB && near(px(b, nx, ny), pa)) shiftB = true;
      if (shiftA && shiftB) break outer;
    }
    if (shiftA && shiftB) { aa++; out[io] = 255; out[io + 1] = 200; out[io + 2] = 0; }
    else {
      bad++; out[io] = 255; out[io + 1] = 40; out[io + 2] = 40;
      const ck = ((y >> 5) * cols) + (x >> 5);
      let cell = cells.get(ck);
      if (!cell) cells.set(ck, cell = { count: 0, minX: x, minY: y, maxX: x, maxY: y });
      cell.count++;
      if (x < cell.minX) cell.minX = x; if (x > cell.maxX) cell.maxX = x;
      if (y < cell.minY) cell.minY = y; if (y > cell.maxY) cell.maxY = y;
    }
  }
  // Distinct mismatch regions (not one page-spanning bounding box): 32px grid
  // cells with bad pixels, flood-filled into clusters, largest first.
  const clusters = clusterCells(cells, cols);
  const box = clusters[0] ?? null;
  const density = box ? (100 * box.bad / (box.w * box.h)) : 0;
  return { width: w, height: h, data: out, bad, aa, total: w * h, pct: 100 * bad / (w * h), aaPct: 100 * aa / (w * h), box, density, clusters };
}

function clusterCells(cells, cols) {
  const seen = new Set(), clusters = [];
  for (const key of cells.keys()) {
    if (seen.has(key)) continue;
    seen.add(key);
    const stack = [key];
    const c = { bad: 0, minX: Infinity, minY: Infinity, maxX: -1, maxY: -1 };
    while (stack.length) {
      const k = stack.pop(), cell = cells.get(k);
      c.bad += cell.count;
      if (cell.minX < c.minX) c.minX = cell.minX; if (cell.minY < c.minY) c.minY = cell.minY;
      if (cell.maxX > c.maxX) c.maxX = cell.maxX; if (cell.maxY > c.maxY) c.maxY = cell.maxY;
      const cx = k % cols, cy = (k / cols) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || nx >= cols || ny < 0) continue;
        const nk = ny * cols + nx;
        if (cells.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
      }
    }
    clusters.push({ x: c.minX, y: c.minY, w: c.maxX - c.minX + 1, h: c.maxY - c.minY + 1, bad: c.bad });
  }
  return clusters.sort((a, b) => b.bad - a.bad);
}

// ---------- browser (Edge/Chrome headless over CDP) ----------

function findBrowser() {
  const c = [
    join(process.env['PROGRAMFILES(X86)'] ?? '', 'Microsoft/Edge/Application/msedge.exe'),
    join(process.env.PROGRAMFILES ?? '', 'Microsoft/Edge/Application/msedge.exe'),
    join(process.env.PROGRAMFILES ?? '', 'Google/Chrome/Application/chrome.exe'),
    join(process.env['PROGRAMFILES(X86)'] ?? '', 'Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const hit = c.find(p => p && existsSync(p));
  if (!hit) throw new Error('no Edge/Chrome found — install one or add to the paths in findBrowser()');
  return hit;
}

class Browser {
  static async launch() {
    const port = 19222 + Math.floor(Math.random() * 20000);
    const profile = await mkdtemp(join(tmpdir(), 'fmv-'));
    const proc = spawn(findBrowser(), [
      '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--disable-gpu',
      '--disable-extensions', 'about:blank',
    ], { stdio: 'ignore' });
    let target;
    for (let i = 0; i < 100; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find(t => t.type === 'page');
        if (target) break;
      } catch { /* not up yet */ }
      await new Promise(r => setTimeout(r, 150));
    }
    if (!target) { proc.kill(); throw new Error('browser did not start'); }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    return new Browser(proc, profile, ws);
  }

  constructor(proc, profile, ws) {
    this.proc = proc; this.profile = profile; this.ws = ws;
    this.id = 0; this.pending = new Map(); this.waiters = new Map(); this.inflight = 0;
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method === 'Network.requestWillBeSent') this.inflight++;
      else if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') this.inflight = Math.max(0, this.inflight - 1);
      else if (m.method && this.waiters.has(m.method)) {
        this.waiters.get(m.method)();
        this.waiters.delete(m.method);
      }
    };
  }

  send(method, params = {}) {
    return new Promise((res, rej) => {
      this.pending.set(++this.id, { res, rej });
      this.ws.send(JSON.stringify({ id: this.id, method, params }));
    });
  }

  waitFor(method, timeoutMs = 20000) {
    return new Promise((res, rej) => {
      this.waiters.set(method, res);
      setTimeout(() => { this.waiters.delete(method); rej(new Error(`timeout waiting for ${method}`)); }, timeoutMs);
    });
  }

  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'page JS error');
    return r.result.value;
  }

  // Wait until no request has been in flight for quietMs — SPAs fetch data
  // after the load event; snapping before that captures loading spinners.
  async waitNetworkIdle(quietMs = 500, timeoutMs = 10000) {
    const start = Date.now();
    let quietSince = this.inflight === 0 ? Date.now() : null;
    while (Date.now() - start < timeoutMs) {
      if (this.inflight === 0) {
        quietSince ??= Date.now();
        if (Date.now() - quietSince >= quietMs) return;
      } else quietSince = null;
      await new Promise(r => setTimeout(r, 100));
    }
    console.log('  warning: network still active after 10s — snapping anyway');
  }

  // Deterministic load: fixed metrics, no animations, media paused, fonts
  // ready, network idle, layout settled.
  async open(url, width, waitForSel = null, scale = 2, height = 900) {
    await this.send('Emulation.setDeviceMetricsOverride', { mobile: false, width, height, deviceScaleFactor: scale });
    await this.send('Page.enable');
    await this.send('Network.enable');
    const loaded = this.waitFor('Page.loadEventFired');
    await this.send('Page.navigate', { url });
    await loaded;
    await this.waitNetworkIdle();
    if (waitForSel) await this.eval(`(async () => {
      const t0 = Date.now();
      while (!document.querySelector(${JSON.stringify(waitForSel)})) {
        if (Date.now() - t0 > 15000) throw new Error('timeout waiting for selector ${waitForSel.replace(/'/g, '')}');
        await new Promise(r => setTimeout(r, 100));
      }
    })()`);
    await this.eval(`(async () => {
      const s = document.createElement('style');
      s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';
      document.head.appendChild(s);
      for (const m of document.querySelectorAll('video,audio')) { try { m.pause(); m.currentTime = 0; } catch {} }
      await document.fonts.ready;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    })()`);
  }

  async screenshot() {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    return Buffer.from(r.data, 'base64');
  }

  async close() {
    try { this.ws.close(); this.proc.kill(); } catch { /* already gone */ }
    await new Promise(r => setTimeout(r, 300));
    await rm(this.profile, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------- figma-node vs DOM comparison ----------

const norm = s => (s ?? '').replace(/\s+/g, ' ').trim();
const rgbVals = s => (String(s).match(/\d+/g) ?? []).slice(0, 3).map(Number);
const colorNear = (a, b) => {
  const x = rgbVals(a), y = rgbVals(b);
  return x.length === 3 && y.length === 3 && x.every((v, i) => Math.abs(v - y[i]) <= 2);
};

function figmaTextNodes(node, origin, out = []) {
  if (node.type === 'TEXT' && node.absoluteBoundingBox && node.visible !== false) {
    const fill = (node.fills ?? []).find(f => f.type === 'SOLID' && f.visible !== false);
    out.push({
      text: norm(node.characters).slice(0, 300),
      x: node.absoluteBoundingBox.x - origin.x,
      y: node.absoluteBoundingBox.y - origin.y,
      fontSize: node.style?.fontSize,
      fontWeight: node.style?.fontWeight,
      fontFamily: node.style?.fontFamily,
      color: fill?.color ? `rgb(${Math.round(fill.color.r * 255)}, ${Math.round(fill.color.g * 255)}, ${Math.round(fill.color.b * 255)})` : null,
      alpha: fill ? (fill.opacity ?? 1) * (fill.color?.a ?? 1) * (node.opacity ?? 1) : null,
    });
  }
  for (const c of node.children ?? []) figmaTextNodes(c, origin, out);
  return out;
}

// Deltas are reported as build→figma (current value → what the design says).
function compareTextNodes(figma, dom) {
  const deltas = [];
  let matched = 0;
  for (const f of figma) {
    if (!f.text) continue;
    // Same label can appear many times (five "Edit" buttons) — take the
    // candidate closest to the figma node's position.
    let el = null, bestDist = Infinity;
    for (const d of dom) {
      if (norm(d.text) !== f.text) continue;
      const dist = Math.hypot(d.x - f.x, d.y - f.y);
      if (dist < bestDist) { bestDist = dist; el = d; }
    }
    if (!el) { deltas.push(`"${f.text.slice(0, 40)}": not found in DOM`); continue; }
    matched++;
    const diffs = [];
    if (f.fontSize && Math.abs(el.fontSize - f.fontSize) > 0.5) diffs.push(`font-size ${el.fontSize}px→${f.fontSize}px`);
    if (f.fontWeight && Number(el.fontWeight) !== f.fontWeight) diffs.push(`font-weight ${el.fontWeight}→${f.fontWeight}`);
    if (f.fontFamily && !el.fontFamily.toLowerCase().includes(f.fontFamily.toLowerCase().split(' ')[0])) diffs.push(`font-family "${el.fontFamily}"→"${f.fontFamily}"`);
    if (f.color && !colorNear(el.color, f.color)) diffs.push(`color ${el.color}→${f.color}`);
    if (f.alpha != null && Math.abs((el.alpha ?? 1) - f.alpha) > 0.05) diffs.push(`opacity ${(el.alpha ?? 1).toFixed(2)}→${f.alpha.toFixed(2)}`);
    if (Math.abs(el.x - f.x) > 1.5) diffs.push(`x ${el.x.toFixed(1)}→${f.x.toFixed(1)}`);
    if (Math.abs(el.y - f.y) > 1.5) diffs.push(`y ${el.y.toFixed(1)}→${f.y.toFixed(1)}`);
    if (diffs.length) deltas.push(`"${f.text.slice(0, 40)}": ${diffs.join(', ')}`);
  }
  return { deltas, matched, total: figma.filter(f => f.text).length };
}

const DOM_TEXT_DUMP = `(() => {
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const text = walker.currentNode.textContent.trim();
    const el = walker.currentNode.parentElement;
    if (!text || !el) continue;
    // Figma's TEXT bbox is the line box, which starts at the parent's CONTENT
    // box (border box + padding/border) — not the parent rect (includes
    // padding) and not a Range rect (font inline box, overflows tight
    // line-heights).
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    const x = r.x + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
    const y = r.y + parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth);
    const parts = (cs.color.match(/rgba?\\(([^)]+)\\)/) ?? [, ''])[1].split(',').map(parseFloat);
    const alpha = (isNaN(parts[3]) ? 1 : parts[3]) * parseFloat(cs.opacity);
    out.push({ text: text.slice(0, 300), x, y, fontSize: parseFloat(cs.fontSize), fontWeight: cs.fontWeight, fontFamily: cs.fontFamily, color: cs.color, alpha });
  }
  return out;
})()`;

// Elements overlapping the diff bounding box (CSS px), smallest first —
// turns "red region at (x,y)" into "it's the .btn".
const elementsInBox = box => `(() => {
  const bx = ${JSON.stringify(box)};
  const hits = [];
  for (const el of document.querySelectorAll('body, body *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const ox = Math.max(0, Math.min(r.right, bx.x + bx.w) - Math.max(r.left, bx.x));
    const oy = Math.max(0, Math.min(r.bottom, bx.y + bx.h) - Math.max(r.top, bx.y));
    if ((ox * oy) / (bx.w * bx.h) > 0.25) hits.push({ area: r.width * r.height, el });
  }
  hits.sort((p, q) => p.area - q.area);
  return hits.slice(0, 4).map(h => {
    const el = h.el;
    let sel = el.tagName.toLowerCase();
    if (el.id) sel += '#' + el.id;
    else if (el.classList.length) sel += '.' + [...el.classList].slice(0, 3).join('.');
    return { selector: sel, text: (el.textContent || '').trim().slice(0, 40) };
  });
})()`;

// ---------- commands ----------

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
}

async function snap(url, width, out) {
  const b = await Browser.launch();
  try {
    await b.open(url, width, arg('wait-for', null));
    await writeFile(out, await b.screenshot());
    console.log(`saved ${out} (page at ${width}px, 2x)`);
  } finally { await b.close(); }
}

const INSPECT_PROPS = [
  'width', 'height', 'padding', 'margin', 'display', 'gap', 'flexDirection', 'justifyContent', 'alignItems',
  'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAlign',
  'color', 'backgroundColor', 'borderRadius', 'border', 'boxShadow', 'opacity', 'position',
];

async function inspect(url, selector, width) {
  const b = await Browser.launch();
  try {
    await b.open(url, width, arg('wait-for', null));
    const result = await b.eval(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})].slice(0, 10);
      return els.map(el => {
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el), styles = {};
        for (const p of ${JSON.stringify(INSPECT_PROPS)}) styles[p] = cs[p];
        return { rect: { x: Math.round(r.x * 100) / 100, y: Math.round(r.y * 100) / 100, w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 }, styles, text: (el.textContent || '').trim().slice(0, 60) };
      });
    })()`);
    if (!result.length) console.log(`no elements match ${selector}`);
    else console.log(JSON.stringify(result, null, 1));
  } finally { await b.close(); }
}

function printDiffReport(a, b, d, out, scale = 2) {
  if (a.width !== b.width || a.height !== b.height)
    console.log(`size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height} (compared overlap)`);
  console.log(`diff: ${d.pct.toFixed(2)}% real mismatch (red), ${d.aaPct.toFixed(2)}% edge/antialiasing noise (yellow) → heatmap ${out}`);
  for (const c of (d.clusters ?? []).slice(0, 3))
    console.log(`mismatch region: ${c.w}x${c.h} at (${c.x},${c.y}), ${c.bad} px (${scale}x px — divide by ${scale} for CSS px)`);
  if ((d.clusters?.length ?? 0) > 3) console.log(`  ...and ${d.clusters.length - 3} smaller regions`);
  const verdict = d.bad === 0 ? (d.aa ? 'MATCH (edge rendering noise only)' : 'MATCH')
    : d.pct < 1 && d.density < 15 ? 'NEAR-MATCH — likely rendering noise, confirm on heatmap'
    : d.pct < 5 ? 'LOCALIZED MISMATCH — something concrete differs, check heatmap region'
    : 'MISMATCH — check heatmap';
  console.log(`verdict hint: ${verdict}`);
  return verdict;
}

async function diffCmd(fileA, fileB, out) {
  const a = pngDecode(await readFile(fileA)), b = pngDecode(await readFile(fileB));
  const d = pixelDiff(a, b);
  await writeFile(out, pngEncode(d.width, d.height, d.data));
  printDiffReport(a, b, d, out);
}

async function verify(url, slugName, mirror) {
  const node = JSON.parse(await readFile(join(mirror, 'nodes', `${slugName}.json`), 'utf8'));
  const width = Math.round(node.absoluteBoundingBox?.width ?? 1440);
  const figmaPng = join(mirror, 'frames', `${slugName}.png`);
  const hasRef = existsSync(figmaPng);
  if (!hasRef) console.log(`no reference render at ${figmaPng} — pixel diff skipped, structural checks only`);
  const outDir = join(mirror, 'verify');
  await mkdir(outDir, { recursive: true });
  const buildPng = join(outDir, `${slugName}-build.png`);
  const diffPng = join(outDir, `${slugName}-diff.png`);

  // Match the browser's pixel density to the reference render: REST exports
  // are 2x, plugin-bridge screenshots may be 1x. Mismatched scales would
  // pixel-diff garbage.
  let scale = 2, fig = null;
  if (hasRef) {
    fig = pngDecode(await readFile(figmaPng));
    scale = Math.min(4, Math.max(1, Math.round(fig.width / width)));
  }
  // Viewport = frame size, so a pixel-exact build produces a pixel-exact
  // screenshot; leftover height difference is real overflow, not noise.
  const frameH = Math.round(node.absoluteBoundingBox?.height ?? 900);
  console.log(`frame ${width}x${frameH}px — snapping build at ${scale}x...`);
  const b = await Browser.launch();
  try {
    await b.open(url, width, arg('wait-for', null), scale, frameH);
    const shot = await b.screenshot();
    await writeFile(buildPng, shot);
    const origin = node.absoluteBoundingBox ?? { x: 0, y: 0 };
    const cmp = compareTextNodes(figmaTextNodes(node, origin), await b.eval(DOM_TEXT_DUMP));

    if (hasRef) {
      const build = pngDecode(shot);
      const d = pixelDiff(fig, build);
      await writeFile(diffPng, pngEncode(d.width, d.height, d.data));
      if (build.height > fig.height + 2)
        console.log(`build overflows the frame by ~${Math.round((build.height - fig.height) / scale)} CSS px — content below the frame is uncompared`);
      printDiffReport(fig, build, d, diffPng, scale);

      for (const c of (d.clusters ?? []).slice(0, 3)) {
        const els = await b.eval(elementsInBox({ x: c.x / scale, y: c.y / scale, w: c.w / scale, h: c.h / scale }));
        if (els.length) {
          // Red on a text element whose computed styles all agree with the
          // design = font rasterization difference, not a build error.
          const rasterNote = els[0].text && !cmp.deltas.length ? ' — styles verified, likely font rasterization' : '';
          console.log(`elements in region (${c.x},${c.y}) ${c.w}x${c.h} (smallest first)${rasterNote}:`);
          for (const e of els) console.log(`  ${e.selector}${e.text ? ` — "${e.text}"` : ''}`);
        }
      }
    }

    console.log(`\ntext-node check: ${cmp.matched}/${cmp.total} figma text nodes found in DOM`);
    if (cmp.deltas.length) {
      console.log('style deltas (build→figma):');
      for (const line of cmp.deltas) console.log(`  ${line}`);
    } else if (cmp.total) console.log('all matched text styles agree');
  } finally { await b.close(); }
}

function selftest() {
  const w = 40, h = 30, img = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { img[i * 4] = (i * 7) & 255; img[i * 4 + 1] = (i * 13) & 255; img[i * 4 + 2] = (i * 29) & 255; img[i * 4 + 3] = 255; }
  const decoded = pngDecode(pngEncode(w, h, img));
  console.assert(decoded.width === w && decoded.height === h, 'roundtrip dims');
  console.assert(decoded.data.equals(img), 'roundtrip pixels');
  const same = pixelDiff(decoded, { width: w, height: h, data: img });
  console.assert(same.bad === 0, 'identical images diff 0');
  const altered = Buffer.from(img); for (let i = 0; i < 200 * 4; i += 4) altered[i] = 255 - altered[i];
  const d = pixelDiff({ width: w, height: h, data: img }, { width: w, height: h, data: altered });
  console.assert(d.bad > 0, `altered pixels detected (${d.bad} red, ${d.aa} aa)`);
  console.assert(crc32(Buffer.from('IEND')) === 0xae426082, 'crc32 known value');
  // 1px edge shift must classify as antialiasing (yellow), not mismatch (red)
  const mk = cut => {
    const data = Buffer.alloc(10 * 6 * 4, 255);
    for (let y = 0; y < 6; y++) for (let x = 0; x < cut; x++) { const i = (y * 10 + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0; }
    return { width: 10, height: 6, data };
  };
  const e = pixelDiff(mk(4), mk(5));
  console.assert(e.bad === 0 && e.aa > 0, `edge shift is AA not mismatch (red ${e.bad}, aa ${e.aa})`);
  // two far-apart changes must report as two clusters, not one giant box
  const cw = 200, ch = 40, base = Buffer.alloc(cw * ch * 4, 255), two = Buffer.from(base);
  const blot = (px0, py0) => { for (let y = py0; y < py0 + 8; y++) for (let x = px0; x < px0 + 8; x++) { const i = (y * cw + x) * 4; two[i] = 0; two[i + 1] = 0; two[i + 2] = 0; } };
  blot(5, 5); blot(150, 20);
  const cd = pixelDiff({ width: cw, height: ch, data: base }, { width: cw, height: ch, data: two });
  console.assert(cd.clusters.length === 2, `two clusters found (${cd.clusters.length})`);
  console.assert(cd.clusters[0].w <= 12 && cd.clusters[1].w <= 12, 'clusters are tight boxes');
  // figma-vs-DOM text comparison
  const fig = [{ text: 'Pay now', x: 40, y: 99, fontSize: 16, fontWeight: 600, fontFamily: 'Inter', color: 'rgb(79, 70, 229)' }];
  const dom = [{ text: 'Pay now', x: 40, y: 99, fontSize: 14, fontWeight: '600', fontFamily: 'Inter, sans-serif', color: 'rgb(80, 70, 230)' }];
  const c = compareTextNodes(fig, dom);
  console.assert(c.matched === 1 && c.deltas.length === 1 && c.deltas[0].includes('font-size 14px→16px') && !c.deltas[0].includes('color'), `delta detection (${c.deltas[0] ?? 'none'})`);
  // opacity mismatch must be caught even when RGB matches
  const fa = [{ text: 'Sub', x: 0, y: 0, fontSize: 14, color: 'rgb(0, 0, 0)', alpha: 0.8 }];
  const da = [{ text: 'Sub', x: 0, y: 0, fontSize: 14, fontWeight: '400', fontFamily: 'Inter', color: 'rgb(0, 0, 0)', alpha: 1 }];
  const ca = compareTextNodes(fa, da);
  console.assert(ca.deltas.length === 1 && ca.deltas[0].includes('opacity 1.00→0.80'), `alpha delta (${ca.deltas[0] ?? 'none'})`);
  console.log('selftest ok');
}

// ---------- main ----------

const [cmd, p1, p2] = process.argv.slice(2);
try {
  if (cmd === 'selftest') selftest();
  else if (cmd === 'snap' && p1) await snap(p1, Number(arg('width', 1440)), arg('out', 'build.png'));
  else if (cmd === 'inspect' && p1 && p2) await inspect(p1, p2, Number(arg('width', 1440)));
  else if (cmd === 'diff' && p1 && p2) await diffCmd(p1, p2, arg('out', 'diff.png'));
  else if (cmd === 'verify' && p1 && p2) await verify(p1, p2, process.argv[5] && !process.argv[5].startsWith('--') ? process.argv[5] : 'figma-mirror-data');
  else console.log('usage: verify.mjs snap <url> [--width N] [--out f.png]\n       verify.mjs inspect <url> <selector> [--width N]\n       verify.mjs diff <a.png> <b.png> [--out diff.png]\n       verify.mjs verify <url> <frame-slug> [mirror-dir]\n       verify.mjs selftest');
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
