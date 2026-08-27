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
//
// https unless the service leaves no choice: one source is reached over plain
// http because its free tier offers nothing else, and that is also what keeps
// it on HTTP/1.1. Anything reached in the clear is marked insecure here and is
// treated as a weaker witness by the vote.

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
    id: 'seeip.org',
    url: 'https://api.seeip.org/geoip',
    // Answers over plain HTTP/1.1, which is what makes dropConnections() below
    // work: see the comment there for why at least one such source is needed.
    http1: true,
    parse: (d) => ({ ip: d.ip, cc: d.country_code }),
  },
  {
    id: 'ip-api.com',
    // The free tier is http-only, and that is precisely what pins it to
    // HTTP/1.1, so dropConnections() can close its socket. The query asks for
    // three fields and nothing else. Plain http also means the answer can be
    // rewritten on the way, which is why a reading from here never overturns
    // the https sources on its own - see the fresh-witness rule in consensus.js.
    url: 'http://ip-api.com/json/?fields=status,message,countryCode,query',
    http1: true,
    insecure: true,
    parse: (d) => ({ ip: d.query, cc: d.countryCode }),
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
  // Marks the answers that dropConnections() guarantees came over a connection
  // dialled after the last check, which is what lets the vote spot the others
  // as answers from a route that is no longer in use.
  const fresh = Boolean(source?.http1);
  // An answer that travelled in the clear can be rewritten between here and the
  // service, so the vote is told which readings carry that caveat.
  const secure = !source?.insecure;
  try {
    const data = await fetchImpl(source.url);
    if (!data || typeof data !== 'object') throw new Error('unexpected response');
    const result = normalize(source.parse(data));
    if (!result) throw new Error('unexpected response');
    return { id, ip: result.ip, cc: result.cc, error: null, fresh, secure };
  } catch (err) {
    return { id, ip: null, cc: null, error: describeError(err), fresh, secure };
  }
}

/**
 * Queries every source in parallel, preserving SOURCES order in the result.
 * A source that `shouldProbe` turns down is reported as skipped rather than
 * dropped, so the popup can still account for all of them.
 */
export function probeAll(fetchImpl, shouldProbe) {
  return Promise.all(SOURCES.map((s) => (
    !shouldProbe || shouldProbe(s)
      ? probeSource(s, fetchImpl)
      : {
        id: s.id, ip: null, cc: null, error: 'not checked',
        fresh: Boolean(s.http1), secure: !s.insecure, skipped: true,
      }
  )));
}

// Chrome keeps connections alive between checks, and a socket opened before a
// VPN was switched on keeps leaving through the old route: the service then
// reports the address the browser used to exit from rather than the current
// one, and no amount of pressing Refresh changes that - the request travels
// down the same socket. Cache headers do not help either, the answer is not
// cached, it is genuinely fetched over the wrong route.
//
// The only lever an extension has over the socket pool is an aborted request:
// an unfinished exchange leaves the connection unusable, so Chrome closes it
// and the next check has to dial out again, over whatever route is current by
// then. That works on HTTP/1.1 only - over HTTP/2 an abort resets one stream
// and leaves the session open - which is why one source is deliberately kept
// on a server that speaks HTTP/1.1, and why its verdict outranks the rest when
// they disagree about both the address and the country.
function dropOne(url, fetchImpl) {
  const ctl = new AbortController();
  let request;
  try {
    request = fetchImpl(url, { cache: 'no-store', credentials: 'omit', signal: ctl.signal });
  } catch {
    return Promise.resolve();
  }
  ctl.abort(); // the request is never meant to finish; closing the socket is the point
  return Promise.resolve(request).catch(() => {});
}

/**
 * Closes the pooled connections that the next check must not reuse. Call it
 * after every check: the abort has to happen while nothing else is waiting on
 * the socket, and the connection it kills is the one the next check would
 * otherwise inherit.
 */
export function dropConnections(fetchImpl = (...args) => fetch(...args)) {
  return Promise.all(SOURCES.filter((s) => s.http1).map((s) => dropOne(s.url, fetchImpl)));
}
