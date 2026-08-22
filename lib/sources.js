// Public "what is my IP" services. Each one reports both the exit IP and its
// country in a single response, so no local geo database is needed.
//
// Several services are queried on every check on purpose: single services go
// down (api.myip.com was unreachable for hours during development) and an exit
// IP behind a VPN pool can differ between two requests made a second apart.
//
// Every endpoint here must answer with `Access-Control-Allow-Origin: *`. That
// is what lets the extension ship with no host permissions at all, so adding a
// source means checking that header first.

import { canonicalize, isPublicIp } from './ip.js';

export const SOURCES = [
  {
    id: 'country.is',
    url: 'https://api.country.is/',
    parse: (d) => ({ ip: d.ip, cc: d.country }),
  },
  {
    id: 'geojs.io',
    url: 'https://get.geojs.io/v1/ip/country.json',
    parse: (d) => ({ ip: d.ip, cc: d.country }),
  },
  {
    id: 'myip.com',
    url: 'https://api.myip.com/',
    parse: (d) => ({ ip: d.ip, cc: d.cc }),
  },
];

const TIMEOUT_MS = 6000;
const MAX_BYTES = 64 * 1024; // real answers are a few hundred bytes

// Codes that are not real countries: ISO 3166-1 leaves these to private use,
// and some services return them for "unknown".
const USER_ASSIGNED = /^(AA|ZZ|Q[M-Z]|X[A-Z])$/;
// Codes some services use that ISO spells differently.
const CC_ALIASES = { UK: 'GB', EL: 'GR' };

/** Validates one parsed response; returns {ip, cc} or null. */
export function normalize(parsed) {
  if (!parsed) return null;
  const ip = canonicalize(typeof parsed.ip === 'string' ? parsed.ip : '');
  if (!ip || !isPublicIp(ip)) return null;
  let cc = typeof parsed.cc === 'string' ? parsed.cc.trim().toUpperCase() : '';
  cc = CC_ALIASES[cc] ?? cc;
  if (!/^[A-Z]{2}$/.test(cc) || USER_ASSIGNED.test(cc)) cc = null;
  return { ip, cc };
}

// Reads a response body with a hard size cap, so a broken service or a captive
// portal cannot stream the service worker out of memory inside the timeout.
async function readCapped(res) {
  if (!res.body) {
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error('response too large');
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('response too large');
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const buf = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buf);
}

async function fetchJson(url) {
  const res = await fetch(url, {
    cache: 'no-store',
    credentials: 'omit',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await readCapped(res);
  try {
    return JSON.parse(text);
  } catch {
    // Deliberately not the parser's message: it quotes the response body, which
    // would then be stored and shown in the popup.
    throw new Error('invalid response');
  }
}

// Short, safe labels only - never text derived from a response body.
function describeError(err) {
  const name = err?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'timed out';
  if (name === 'TypeError') return 'network error';
  const message = String(err?.message ?? err);
  return /^(HTTP \d{3}|invalid response|unexpected response|response too large)$/.test(message)
    ? message
    : 'failed';
}

/**
 * Queries one source. Never throws: failures come back as {id, error}.
 * fetchImpl is injectable so tests can run without network access.
 */
export async function probeSource(source, fetchImpl = fetchJson) {
  const id = source?.id ?? 'unknown';
  try {
    const data = await fetchImpl(source.url);
    if (!data || typeof data !== 'object') throw new Error('unexpected response');
    const result = normalize(source.parse(data));
    if (!result) throw new Error('unexpected response');
    return { id, ip: result.ip, cc: result.cc, error: null };
  } catch (err) {
    return { id, ip: null, cc: null, error: describeError(err) };
  }
}

/** Queries every source in parallel, preserving SOURCES order in the result. */
export function probeAll(fetchImpl) {
  return Promise.all(SOURCES.map((s) => probeSource(s, fetchImpl)));
}
