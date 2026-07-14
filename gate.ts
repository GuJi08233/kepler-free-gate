#!/usr/bin/env bun

/**
 * kepler-free-gate — Kepler AI 免费模型反代网关
 *
 * 从公共代理池自动获取 S 级代理，多 IP 轮换使用，失败自动切换
 * 兼容 OpenAI API 格式，支持 /v1/models 和 /v1/chat/completions
 *
 * 使用:
 *   bun run gate.ts          # Bun 运行时（推荐，Docker 默认）
 *   node gate.ts             # Node.js 运行时
 *   PORT=8080 bun run gate.ts
 */

import https from 'node:https';
import http from 'node:http';
import { HttpsProxyAgent } from 'hpagent';
import { SocksProxyAgent } from 'socks-proxy-agent';

interface ProxyItem {
  address: string;
  protocol: string;
  latency: number;
  quality_grade: string;
}

interface Slot {
  addr: string;
  url: string;
  proto: 'http' | 'socks5';
}

const PROXY_API = 'https://proxy.amux.ai/api/proxies';
const UPSTREAM = 'https://oai.endpoints.kepler.ai.cloud.ovh.net';
const PORT = parseInt(process.env.PORT || '13339');
const MAX_RETRIES = 3;
const TIMEOUT = 120000;
const STREAM_TIMEOUT = 300000;
const SLOT_COUNT = Math.max(3, Math.min(5, parseInt(process.env.SLOT_COUNT || '3')));
const PROXY_PROBE_TIMEOUT = parseInt(process.env.PROXY_PROBE_TIMEOUT || '8000');
const PROXY_REFRESH_MS = parseInt(process.env.PROXY_REFRESH_MS || '300000');

// –– 自定义代理配置（兜底备用）––
const CUSTOM_PROXIES = process.env.CUSTOM_PROXIES || '';

// –– ZenProxy 备用通道 ––
const ZENPROXY_RELAY = process.env.ZENPROXY_RELAY || 'https://zenproxy.top/api/relay';
const ZENPROXY_KEY = process.env.ZENPROXY_KEY || '';
const FORCE_RELAY = process.env.FORCE_RELAY === '1';

// –– 网关认证 ––
const GATEWAY_KEY = process.env.GATEWAY_KEY || '';

// –– 全局状态 ––
let candidates: ProxyItem[] = [];
let slots: Slot[] = [];
let customSlots: Slot[] = [];
let rrCursor = 0;
let refreshing = false;

/** 转发到上游时保留的请求头（不转发 authorization，上游会拒绝） */
const FORWARD = [
  'content-type',
  'accept',
];

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  自定义代理解析（兜底备用）
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

function parseCustomProxies(input: string): ProxyItem[] {
  if (!input.trim()) return [];
  return input.split(',').map((addr) => {
    const trimmed = addr.trim();
    if (!trimmed) return null;
    const isSocks = trimmed.startsWith('socks5://') || trimmed.startsWith('socks5h://');
    return {
      address: trimmed.replace(/^https?:\/\//, '').replace(/^socks5h?:\/\//, ''),
      protocol: isSocks ? 'socks5' : 'http',
      latency: 0,
      quality_grade: 'custom',
    };
  }).filter((p): p is ProxyItem => p !== null);
}

async function initCustomSlots(): Promise<void> {
  if (!CUSTOM_PROXIES) return;
  const items = parseCustomProxies(CUSTOM_PROXIES);
  if (items.length === 0) return;

  const results = await Promise.all(items.map(async (item) => {
    const r = await probe(item);
    return { item, ...r };
  }));

  for (const r of results) {
    if (!r.ok) continue;
    const url = r.item.protocol === 'socks5' ? `socks5h://${r.item.address}` : `http://${r.item.address}`;
    customSlots.push({ addr: r.item.address, url, proto: r.item.protocol as 'http' | 'socks5' });
    console.log(`[兜底+] ${r.item.address} (${r.latencyMs}ms)`);
  }
  console.log(`[兜底] ${customSlots.length}/${items.length} custom proxies ready`);
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  候选池（S级免费代理）
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

async function loadCandidates(): Promise<void> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(PROXY_API, { signal: ctl.signal });
    const data = await res.json();
    const all: any[] = Array.isArray(data) ? data : [];
    candidates = all
      .filter((p) => p.quality_grade === 'S' && p.status === 'active')
      .sort((a, b) => a.latency - b.latency);
    console.log(`[选] ${candidates.length} S-grade candidates`);
  } catch (e: any) {
    candidates = [];
    console.warn(`[选] load failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

function nextCandidate(used: Set<string>): ProxyItem | null {
  while (candidates.length > 0) {
    const item = candidates.shift()!;
    if (!used.has(item.address)) return item;
  }
  return null;
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  探活
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

function makeAgent(proxyUrl: string, proto: 'http' | 'socks5'): https.Agent {
  if (proto === 'socks5') {
    return new SocksProxyAgent(proxyUrl, { timeout: 10000 }) as unknown as https.Agent;
  }
  return new HttpsProxyAgent({
    proxy: proxyUrl,
    keepAlive: false,
    timeout: 10000,
  }) as unknown as https.Agent;
}

async function probe(item: ProxyItem): Promise<{ ok: boolean; latencyMs?: number }> {
  const url = item.protocol === 'socks5' ? `socks5h://${item.address}` : `http://${item.address}`;
  const agent = makeAgent(url, item.protocol as 'http' | 'socks5');
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await new Promise<{ status: number }>((resolve, reject) => {
      const req = https.request(
        `${UPSTREAM}/v1/models`,
        {
          method: 'GET',
          headers: { accept: 'application/json' },
          agent,
          rejectUnauthorized: false,
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => {
            if (timer) clearTimeout(timer);
            resolve({ status: res.statusCode || 0 });
          });
          res.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
        },
      );
      req.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
      timer = setTimeout(() => { req.destroy(new Error('probe-timeout')); reject(new Error('probe-timeout')); }, PROXY_PROBE_TIMEOUT);
      req.end();
    });
    return { ok: result.status >= 200 && result.status < 400, latencyMs: Date.now() - start };
  } catch {
    return { ok: false };
  } finally {
    if (timer) clearTimeout(timer);
    try { agent.destroy(); } catch {}
  }
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  Slot 管理：探活 → 填充 → 刷新
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

async function fillSlots(): Promise<void> {
  if (slots.length >= SLOT_COUNT) return;
  const used = new Set(slots.map((s) => s.addr));
  const needed = SLOT_COUNT - slots.length;

  const batch: ProxyItem[] = [];
  while (batch.length < needed + 3) {
    const c = nextCandidate(used);
    if (!c) {
      if (candidates.length === 0) await loadCandidates();
      const c2 = nextCandidate(used);
      if (!c2) break;
      batch.push(c2);
      used.add(c2.address);
      continue;
    }
    batch.push(c);
    used.add(c.address);
  }
  if (batch.length === 0) return;

  const results = await Promise.all(batch.map(async (item) => {
    const r = await probe(item);
    return { item, ...r };
  }));

  let added = 0;
  for (const r of results) {
    if (!r.ok || slots.length >= SLOT_COUNT) continue;
    const url = r.item.protocol === 'socks5' ? `socks5h://${r.item.address}` : `http://${r.item.address}`;
    slots.push({ addr: r.item.address, url, proto: r.item.protocol as 'http' | 'socks5' });
    console.log(`[探+] ${r.item.address} (${r.latencyMs}ms)`);
    added++;
  }
  console.log(`[槽] ${slots.length}/${SLOT_COUNT} ready (added ${added})`);
}

function dropSlot(addr: string): void {
  const idx = slots.findIndex((s) => s.addr === addr);
  if (idx >= 0) {
    slots.splice(idx, 1);
    console.log(`[弃] ${addr} → ${slots.length}/${SLOT_COUNT}`);
  }
  fillSlots().catch((e) => console.error('[槽] fill error:', e.message));
}

async function refreshSlots(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    await loadCandidates();
    await fillSlots();
  } catch (e: any) {
    console.error('[刷新] error:', e.message);
  } finally {
    refreshing = false;
  }
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  请求处理
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

function collectHeaders(headers: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = {};
  for (const k of FORWARD) {
    const v = headers[k];
    if (v) h[k] = v;
  }
  if (!h['content-type']) h['content-type'] = 'application/json';
  return h;
}

function doHttps(
  path: string, method: string, headers: Record<string, string>,
  body: string | undefined, agent: https.Agent,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${UPSTREAM}${path}`,
      { method, headers, agent, timeout: TIMEOUT, rejectUnauthorized: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode || 200, body: Buffer.concat(chunks).toString('utf-8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('超时')));
    if (body) req.write(body);
    req.end();
  });
}

function doHttpsDirect(
  path: string, method: string, headers: Record<string, string>,
  body: string | undefined,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${UPSTREAM}${path}`,
      { method, headers, timeout: TIMEOUT, rejectUnauthorized: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode || 200, body: Buffer.concat(chunks).toString('utf-8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('超时')));
    if (body) req.write(body);
    req.end();
  });
}

/** 核心：轮询选 slot，失败重试，回退策略：S级代理 → ZenProxy → 自定义代理 → 直连 */
async function dispatch(
  path: string, method: string, headers: Record<string, string>,
  body: string | undefined, retry = 0, triedAddrs = new Set<string>(),
): Promise<{ status: number; headers: Record<string, string>; body?: string; stream?: any }> {
  if (FORCE_RELAY) {
    if (ZENPROXY_KEY) return proxyViaRelay(path, method, headers, body);
    return { status: 502, headers: { 'content-type': 'application/json' }, body: '{"error":"FORCE_RELAY 但未配置 ZENPROXY_KEY"}' };
  }

  if (slots.length === 0) await fillSlots();

  const available = slots.filter((s) => !triedAddrs.has(s.addr));
  if (available.length === 0) {
    if (ZENPROXY_KEY) {
      console.log(`[回退] S级代理失败 → ZenProxy relay`);
      return proxyViaRelay(path, method, headers, body);
    }
    if (customSlots.length > 0) {
      console.log(`[回退] S级代理失败 → 自定义代理兜底`);
      return dispatchViaCustom(path, method, headers, body);
    }
    console.log(`[直连] 无可用代理，直接连接上游`);
    return dispatchDirect(path, method, headers, body);
  }

  const slot = available[rrCursor % available.length];
  rrCursor = (rrCursor + 1) % slots.length;

  if (!slot) {
    console.log(`[直连] 无可用代理，直接连接上游`);
    return dispatchDirect(path, method, headers, body);
  }

  triedAddrs.add(slot.addr);
  console.log(`[取] ${slot.addr} (retry=${retry})`);

  const isStream = (headers['accept'] || '').includes('event-stream');
  const agent = makeAgent(slot.url, slot.proto);

  try {
    if (isStream) {
      return new Promise((resolve, reject) => {
        const req = https.request(
          `${UPSTREAM}${path}`,
          { method, headers, agent, timeout: STREAM_TIMEOUT, rejectUnauthorized: false },
          (res) => {
            if (res.statusCode === 429) {
              console.log(`[429] ${slot.addr} 被限流，换IP重试(流式)`);
              res.resume(); // 丢弃限流响应体，释放 socket
              try { agent.destroy(); } catch {}
              dropSlot(slot.addr);
              if (retry < MAX_RETRIES) {
                resolve(dispatch(path, method, headers, body, retry + 1, triedAddrs));
                return;
              }
              if (ZENPROXY_KEY) {
                console.log(`[回退] 429重试耗尽 → ZenProxy relay`);
                resolve(proxyViaRelay(path, method, headers, body));
                return;
              }
              if (customSlots.length > 0) {
                console.log(`[回退] 429重试耗尽 → 自定义代理兜底`);
                resolve(dispatchViaCustom(path, method, headers, body));
                return;
              }
              resolve({ status: 429, headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"error":"rate limited (429), 无可用回退"}' });
              return;
            }
            res.on('end', () => { try { agent.destroy(); } catch {} });
            res.on('error', () => { try { agent.destroy(); } catch {} });
            resolve({ status: res.statusCode || 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' }, stream: res });
          },
        );
        req.on('error', (e) => { try { agent.destroy(); } catch {}; reject(e); });
        if (body) req.write(body);
        req.end();
      });
    }

    const { status, body: respBody } = await doHttps(path, method, headers, body, agent);
    try { agent.destroy(); } catch {}

    if (status === 429) {
      console.log(`[429] ${slot.addr} 被限流，换IP重试`);
      dropSlot(slot.addr);
      if (retry < MAX_RETRIES) {
        return dispatch(path, method, headers, body, retry + 1, triedAddrs);
      }
      if (ZENPROXY_KEY) {
        console.log(`[回退] 429重试耗尽 → ZenProxy relay`);
        return proxyViaRelay(path, method, headers, body);
      }
      if (customSlots.length > 0) {
        console.log(`[回退] 429重试耗尽 → 自定义代理兜底`);
        return dispatchViaCustom(path, method, headers, body);
      }
      return { status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: respBody };
    }

    return { status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: respBody };
  } catch (e: any) {
    console.error(`[错] ${slot.addr}: ${e.message}`);
    try { agent.destroy(); } catch {}

    dropSlot(slot.addr);

    if (retry < MAX_RETRIES) {
      return dispatch(path, method, headers, body, retry + 1, triedAddrs);
    }
    if (ZENPROXY_KEY) {
      console.log(`[回退] 重试耗尽 → ZenProxy relay`);
      return proxyViaRelay(path, method, headers, body);
    }
    if (customSlots.length > 0) {
      console.log(`[回退] 重试耗尽 → 自定义代理兜底`);
      return dispatchViaCustom(path, method, headers, body);
    }
    return { status: 502, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: `所有代理失败: ${e.message}` }) };
  }
}

/** 通过自定义代理兜底转发 */
async function dispatchViaCustom(
  path: string, method: string, headers: Record<string, string>,
  body: string | undefined, retry = 0, triedAddrs = new Set<string>(),
): Promise<{ status: number; headers: Record<string, string>; body?: string; stream?: any }> {
  if (customSlots.length === 0) {
    return { status: 502, headers: { 'content-type': 'application/json' }, body: '{"error":"没有可用的自定义代理"}' };
  }

  const available = customSlots.filter((s) => !triedAddrs.has(s.addr));
  if (available.length === 0) {
    return { status: 502, headers: { 'content-type': 'application/json' }, body: '{"error":"所有自定义代理均失败"}' };
  }

  const slot = available[0];
  triedAddrs.add(slot.addr);
  console.log(`[兜底取] ${slot.addr} (retry=${retry})`);

  const isStream = (headers['accept'] || '').includes('event-stream');
  const agent = makeAgent(slot.url, slot.proto);

  try {
    if (isStream) {
      return new Promise((resolve, reject) => {
        const req = https.request(
          `${UPSTREAM}${path}`,
          { method, headers, agent, timeout: STREAM_TIMEOUT, rejectUnauthorized: false },
          (res) => {
            res.on('end', () => { try { agent.destroy(); } catch {} });
            res.on('error', () => { try { agent.destroy(); } catch {} });
            resolve({ status: res.statusCode || 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' }, stream: res });
          },
        );
        req.on('error', (e) => { try { agent.destroy(); } catch {}; reject(e); });
        if (body) req.write(body);
        req.end();
      });
    }

    const { status, body: respBody } = await doHttps(path, method, headers, body, agent);
    try { agent.destroy(); } catch {}

    return { status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: respBody };
  } catch (e: any) {
    console.error(`[兜底错] ${slot.addr}: ${e.message}`);
    try { agent.destroy(); } catch {}

    if (retry < MAX_RETRIES) {
      return dispatchViaCustom(path, method, headers, body, retry + 1, triedAddrs);
    }
    return { status: 502, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: `所有自定义代理失败: ${e.message}` }) };
  }
}

/** 直连上游（无代理时使用） */
async function dispatchDirect(
  path: string, method: string, headers: Record<string, string>,
  body: string | undefined,
): Promise<{ status: number; headers: Record<string, string>; body?: string; stream?: any }> {
  const isStream = (headers['accept'] || '').includes('event-stream');

  try {
    if (isStream) {
      return new Promise((resolve, reject) => {
        const req = https.request(
          `${UPSTREAM}${path}`,
          { method, headers, timeout: STREAM_TIMEOUT, rejectUnauthorized: false },
          (res) => {
            resolve({ status: res.statusCode || 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' }, stream: res });
          },
        );
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
      });
    }

    const { status, body: respBody } = await doHttpsDirect(path, method, headers, body);
    return { status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: respBody };
  } catch (e: any) {
    console.error(`[直连错] ${e.message}`);
    return { status: 502, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: `直连失败: ${e.message}` }) };
  }
}

/** ZenProxy 备用通道 */
async function proxyViaRelay(
  path: string, method: string, headers: Record<string, string>, body: string | undefined,
): Promise<{ status: number; headers: Record<string, string>; body?: string; stream?: any }> {
  const clean: Record<string, string> = { ...headers };
  delete clean['host'];
  delete clean['content-length'];
  delete clean['authorization'];

  const target = `${UPSTREAM}${path}`;
  const url = `${ZENPROXY_RELAY}?api_key=${encodeURIComponent(ZENPROXY_KEY)}&url=${encodeURIComponent(target)}&method=${method}`;

  const res = await fetch(url, { method: 'POST', headers: clean, body });
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), stream: res.body };
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  通用请求处理器
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

async function handleRequest(method: string, pathname: string, search: string, headers: Record<string, string>, body?: string): Promise<{ status: number; headers: Record<string, string>; body?: string; stream?: any }> {
  // 根路径返回状态
  if (pathname === '/' || pathname === '/v1') {
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'ok', upstream: UPSTREAM, slots: slots.map((s) => s.addr) }),
    };
  }

  // GET /v1/models
  if (pathname === '/v1/models' && method === 'GET') {
    return dispatch('/v1/models' + search, 'GET', collectHeaders(headers));
  }

  // POST /v1/chat/completions
  if (pathname === '/v1/chat/completions' && method === 'POST') {
    const h = collectHeaders(headers);
    const isStream =
      h['accept']?.includes('event-stream') ||
      (() => { try { return JSON.parse(body || '{}').stream; } catch { return false; } })();
    if (isStream) {
      h['accept'] = 'text/event-stream';
      try {
        const json = JSON.parse(body || '{}');
        if (!json.stream) { json.stream = true; body = JSON.stringify(json); }
      } catch {}
    }
    return dispatch('/v1/chat/completions', 'POST', h, body);
  }

  return { status: 404, headers: { 'content-type': 'application/json' }, body: '{"error":"not found"}' };
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  服务启动（兼容 Bun 和 Node.js）
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

console.log(`[门] http://localhost:${PORT}`);
console.log(`[门] 上游:      ${UPSTREAM}`);
console.log(`[门] 端点:      /v1/models | /v1/chat/completions`);
console.log(`[门] 认证:      ${GATEWAY_KEY ? '已启用 GATEWAY_KEY' : '未启用（任何人可访问）'}`);
console.log(`[门] 策略:      S级代理(${SLOT_COUNT}槽) → ${ZENPROXY_KEY ? 'ZenProxy → ' : ''}自定义代理兜底${CUSTOM_PROXIES ? ` (${parseCustomProxies(CUSTOM_PROXIES).length}个)` : '(未配置)'}`);
console.log(`[门] 备用:      ${ZENPROXY_KEY ? `ZenProxy relay 已启用 (${ZENPROXY_RELAY})` : '未配置 ZENPROXY_KEY'}`);
console.log(`[门] 重试:      MAX_RETRIES=${MAX_RETRIES}`);

// 预热
loadCandidates()
  .then(() => fillSlots())
  .then(() => initCustomSlots())
  .then(() => console.log(`[门] 预热完成，服务启动`))
  .catch((e) => console.error('[门] 预热失败:', e.message));

// 检测运行时并启动服务
const isBun = typeof globalThis.Bun !== 'undefined';

if (isBun) {
  // Bun 运行时
  console.log(`[门] 运行时:    Bun`);
  // @ts-ignore
  globalThis.Bun.serve({
    port: PORT,
    idleTimeout: 0,
    async fetch(req: Request) {
      const { pathname, search } = new URL(req.url);
      const method = req.method;
      console.log(`[>] ${method} ${pathname}`);

      // 网关认证检查
      if (GATEWAY_KEY) {
        const auth = req.headers.get('authorization') || '';
        const token = auth.replace(/^Bearer\s+/i, '');
        if (token !== GATEWAY_KEY) {
          return new Response('{"error":"Unauthorized"}', { status: 401, headers: { 'content-type': 'application/json' } });
        }
      }

      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      const body = method === 'POST' ? await req.text() : undefined;

      const result = await handleRequest(method, pathname, search, headers, body);

      if (result.stream) {
        // Bun 下 stream 是 IncomingMessage，需要转换
        const { Readable } = await import('node:stream');
        const nodeStream = result.stream;
        return new Response(Readable.toWeb(nodeStream) as any, {
          status: result.status,
          headers: result.headers,
        });
      }

      return new Response(result.body, {
        status: result.status,
        headers: result.headers,
      });
    },
  });
} else {
  // Node.js 运行时
  console.log(`[门] 运行时:    Node.js`);
  const server = http.createServer(async (req, res) => {
    const { pathname, search } = new URL(req.url || '/', `http://localhost:${PORT}`);
    const method = req.method || 'GET';
    console.log(`[>] ${method} ${pathname}`);

    // 网关认证检查
    if (GATEWAY_KEY) {
      const auth = req.headers['authorization'] || '';
      const token = auth.replace(/^Bearer\s+/i, '');
      if (token !== GATEWAY_KEY) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":"Unauthorized"}');
        return;
      }
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v) headers[k] = Array.isArray(v) ? v[0] : v;
    }

    let body: string | undefined;
    if (method === 'POST') {
      body = await new Promise<string>((resolve) => {
        let data = '';
        req.on('data', (chunk) => data += chunk);
        req.on('end', () => resolve(data));
      });
    }

    const result = await handleRequest(method, pathname, search, headers, body);

    if (result.stream) {
      res.writeHead(result.status, result.headers);
      result.stream.pipe(res);
    } else {
      res.writeHead(result.status, result.headers);
      res.end(result.body);
    }
  });

  server.listen(PORT, () => {
    console.log(`[门] 服务已启动`);
  });
}

// 定期刷新
const refreshTimer = setInterval(() => {
  refreshSlots().catch((e) => console.error('[门] refresh failed:', e));
}, PROXY_REFRESH_MS);

// 优雅退出
process.on('SIGTERM', () => { clearInterval(refreshTimer); process.exit(0); });
process.on('SIGINT', () => { clearInterval(refreshTimer); process.exit(0); });
