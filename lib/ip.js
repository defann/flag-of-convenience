// IP address parsing and classification. Pure module with no Chrome API
// dependencies, so it can be unit-tested under Node.

const V4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** "1.2.3.4" -> uint32 number, or null when the string is not an IPv4 address. */
export function parseIPv4(str) {
  if (typeof str !== 'string') return null;
  const m = V4_RE.exec(str.trim());
  if (!m) return null;
  for (let i = 1; i <= 4; i++) {
    // Leading zeros are rejected: "010" is ambiguous (octal notation).
    if (m[i].length > 1 && m[i][0] === '0') return null;
  }
  const a = +m[1], b = +m[2], c = +m[3], d = +m[4];
  if (a > 255 || b > 255 || c > 255 || d > 255) return null;
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

/** Expands an IPv6 string into 8 uint16 groups, or null when it is invalid. */
export function expandIPv6(str) {
  if (typeof str !== 'string') return null;
  let s = str.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (!s) return null;

  const halves = s.split('::');
  if (halves.length > 2) return null;

  const parseSide = (side, v4Allowed) => {
    if (side === '') return [];
    const parts = side.split(':');
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.includes('.')) {
        // An embedded IPv4 part is only valid at the very end of the address.
        if (!v4Allowed || i !== parts.length - 1) return null;
        const v4 = parseIPv4(p);
        if (v4 === null) return null;
        out.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
        out.push(parseInt(p, 16));
      }
    }
    return out;
  };

  let groups;
  if (halves.length === 2) {
    const left = parseSide(halves[0], false);
    const right = parseSide(halves[1], true);
    if (!left || !right) return null;
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    groups = [...left, ...new Array(missing).fill(0), ...right];
  } else {
    groups = parseSide(s, true);
  }
  return groups && groups.length === 8 ? groups : null;
}

export function isIPv4(str) {
  return parseIPv4(str) !== null;
}

export function isIPv6(str) {
  return !isIPv4(str) && expandIPv6(str) !== null;
}

function classifyV4Num(v) {
  const a = v >>> 24;
  if (a === 0) return 'reserved';
  if (a === 10) return 'private';
  if (a === 127) return 'loopback';
  if ((v >>> 22) === (0x64400000 >>> 22)) return 'cgn'; // 100.64.0.0/10
  if ((v >>> 16) === 0xa9fe) return 'linklocal'; // 169.254.0.0/16
  if ((v >>> 20) === (0xac100000 >>> 20)) return 'private'; // 172.16.0.0/12
  if ((v >>> 16) === 0xc0a8) return 'private'; // 192.168.0.0/16
  if (a >= 224) return 'reserved'; // multicast and reserved space
  return 'public';
}

/**
 * Returns 'public' | 'private' | 'loopback' | 'linklocal' | 'cgn' | 'reserved',
 * or null when the string is not an IP address at all.
 */
export function classify(str) {
  const v4 = parseIPv4(str);
  if (v4 !== null) return classifyV4Num(v4);

  const g = expandIPv6(str);
  if (!g) return null;

  // Addresses that embed an IPv4 address are classified by that address, so a
  // private or loopback address cannot slip through in IPv6 clothing.
  const topZero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0;
  const low32 = ((g[6] << 16) | g[7]) >>> 0;
  if (topZero && g[4] === 0 && g[5] === 0xffff) return classifyV4Num(low32); // ::ffff:a.b.c.d
  if (topZero && g[4] === 0xffff && g[5] === 0) return classifyV4Num(low32); // ::ffff:0:a.b.c.d
  if (topZero && g[4] === 0 && g[5] === 0) {
    if (low32 === 0) return 'reserved'; // ::
    if (low32 === 1) return 'loopback'; // ::1
    return classifyV4Num(low32); // ::a.b.c.d (deprecated IPv4-compatible form)
  }

  const top = g[0];
  if ((top & 0xffc0) === 0xfe80) return 'linklocal'; // fe80::/10
  if ((top & 0xfe00) === 0xfc00) return 'private'; // fc00::/7 (ULA)
  if ((top & 0xff00) === 0xff00) return 'reserved'; // ff00::/8 multicast
  return 'public';
}

/** True when the string is a routable public address. */
export function isPublicIp(str) {
  return classify(str) === 'public';
}

/**
 * Canonical text form of an address: brackets and IPv6 zone ids removed,
 * hex lowercased. Returns null when the string is not an IP address.
 * Services occasionally answer with '[2606:4700::1]' or 'fe80::1%eth0', and
 * that raw text would otherwise end up in the popup and on the clipboard.
 */
export function canonicalize(str) {
  if (isIPv4(str)) return str.trim();
  const g = expandIPv6(str);
  if (!g) return null;
  // Compress the longest run of zero groups, as RFC 5952 requires.
  let bestStart = -1, bestLen = 0, runStart = -1;
  for (let i = 0; i <= 8; i++) {
    if (i < 8 && g[i] === 0) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      const len = i - runStart;
      if (len > bestLen) { bestLen = len; bestStart = runStart; }
      runStart = -1;
    }
  }
  const parts = g.map((x) => x.toString(16));
  if (bestLen < 2) return parts.join(':');
  return `${parts.slice(0, bestStart).join(':')}::${parts.slice(bestStart + bestLen).join(':')}`;
}
