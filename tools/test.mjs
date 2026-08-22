#!/usr/bin/env node
// Unit tests for IP parsing, source normalization and the consensus rules.
//
//   node tools/test.mjs

import { parseIPv4, expandIPv6, classify, isIPv4, isIPv6, isPublicIp, canonicalize } from '../lib/ip.js';
import { normalize, probeSource, probeAll, SOURCES } from '../lib/sources.js';
import { consensus } from '../lib/consensus.js';
import { flagEmoji, countryName, ccColor } from '../lib/flags.js';

let failed = 0;
let passed = 0;

function ok(cond, label) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${label}`);
  }
}

function eq(actual, expected, label) {
  ok(actual === expected, `${label}: expected ${expected}, got ${actual}`);
}

// ---------- parseIPv4 ----------
eq(parseIPv4('0.0.0.0'), 0, 'v4 zeros');
eq(parseIPv4('255.255.255.255'), 0xffffffff, 'v4 max');
eq(parseIPv4('8.8.8.8'), 0x08080808, 'v4 8.8.8.8');
eq(parseIPv4('1.2.3.256'), null, 'v4 octet above 255');
eq(parseIPv4('1.2.3'), null, 'v4 three octets');
eq(parseIPv4('1.2.3.4.5'), null, 'v4 five octets');
eq(parseIPv4('a.b.c.d'), null, 'v4 letters');
eq(parseIPv4(''), null, 'v4 empty string');
eq(parseIPv4('010.8.8.8'), null, 'v4 leading zero');
eq(parseIPv4('192.168.001.001'), null, 'v4 leading zeros in octets');
eq(parseIPv4('0.0.0.1'), 1, 'v4 single zeros are fine');

// ---------- IPv6 ----------
eq(expandIPv6('1::2::3'), null, 'v6 double ::');
eq(expandIPv6('1:2:3:4:5:6:7'), null, 'v6 seven groups');
eq(expandIPv6('1:2:3:4:5:6:7:8:9'), null, 'v6 nine groups');
eq(expandIPv6('gggg::1'), null, 'v6 non-hex');
eq(expandIPv6('12345::1'), null, 'v6 group too long');
eq(expandIPv6('1.2.3.4::'), null, 'v6 embedded v4 before ::');
eq(expandIPv6('a:1.2.3.4::5'), null, 'v6 embedded v4 in the middle');
ok(expandIPv6('::1.2.3.4') !== null, 'v6 embedded v4 at the end is valid');
ok(expandIPv6('64:ff9b::8.8.8.8') !== null, 'v6 NAT64 form is valid');
ok(expandIPv6('1:2:3:4:5:6:7:8')?.length === 8, 'v6 full form');
ok(expandIPv6('::ffff:192.0.2.1')?.[5] === 0xffff, 'v6 mapped ffff group');
ok(isIPv6('2606:4700::6810:b9f1'), 'isIPv6 true');
ok(!isIPv6('8.8.8.8'), 'isIPv6 false for v4');
ok(isIPv4('8.8.8.8') && !isIPv4('::1'), 'isIPv4');

// ---------- classify ----------
eq(classify('10.1.2.3'), 'private', 'classify 10/8');
eq(classify('192.168.1.1'), 'private', 'classify 192.168');
eq(classify('172.16.0.1'), 'private', 'classify 172.16');
eq(classify('172.32.0.1'), 'public', 'classify 172.32 is outside the /12');
eq(classify('127.0.0.1'), 'loopback', 'classify v4 loopback');
eq(classify('169.254.10.10'), 'linklocal', 'classify v4 link-local');
eq(classify('100.64.0.1'), 'cgn', 'classify CGN');
eq(classify('100.128.0.1'), 'public', 'classify 100.128 is outside the CGN /10');
eq(classify('224.0.0.1'), 'reserved', 'classify v4 multicast');
eq(classify('8.8.8.8'), 'public', 'classify public v4');
eq(classify('::1'), 'loopback', 'classify v6 loopback');
eq(classify('fe80::1'), 'linklocal', 'classify v6 link-local');
eq(classify('fd00::1'), 'private', 'classify ULA');
eq(classify('ff02::1'), 'reserved', 'classify v6 multicast');
eq(classify('2001:db8::1'), 'public', 'classify public v6');
eq(classify('::ffff:192.168.1.1'), 'private', 'classify mapped private');
eq(classify('not an ip'), null, 'classify garbage');
ok(isPublicIp('1.1.1.1') && !isPublicIp('10.0.0.1'), 'isPublicIp');
eq(classify('0.0.0.0'), 'reserved', 'classify 0.0.0.0');
eq(classify('255.255.255.255'), 'reserved', 'classify broadcast');
eq(classify('239.255.255.255'), 'reserved', 'classify multicast top');
eq(classify('100.63.255.255'), 'public', 'classify just below CGN');
eq(classify('169.253.255.255'), 'public', 'classify just below link-local');
eq(classify('169.255.0.0'), 'public', 'classify just above link-local');
eq(classify('172.15.255.255'), 'public', 'classify just below 172.16/12');
// IPv4 addresses wrapped in IPv6 must keep their own classification.
eq(classify('::10.0.0.1'), 'private', 'classify v4-compatible private');
eq(classify('::127.0.0.1'), 'loopback', 'classify v4-compatible loopback');
eq(classify('::ffff:0:10.0.0.1'), 'private', 'classify v4-translated private');
eq(classify('::ffff:8.8.8.8'), 'public', 'classify v4-mapped public');
eq(classify('::'), 'reserved', 'classify unspecified');
eq(parseIPv4('１.２.３.４'), null, 'v4 rejects full-width digits');
eq(parseIPv4(null), null, 'v4 handles non-string');
eq(expandIPv6(123), null, 'v6 handles non-string');
{
  const t0 = Date.now();
  classify('1'.repeat(1_000_000));
  ok(Date.now() - t0 < 1000, 'classify handles a megabyte of junk quickly');
}

// ---------- canonicalize ----------
eq(canonicalize('8.8.8.8'), '8.8.8.8', 'canonicalize keeps v4');
eq(canonicalize('[2606:4700::1]'), '2606:4700::1', 'canonicalize strips brackets');
eq(canonicalize('fe80::1%eth0'), 'fe80::1', 'canonicalize strips zone id');
eq(canonicalize('2606:4700:0:0:0:0:0:1'), '2606:4700::1', 'canonicalize compresses zeros');
eq(canonicalize('2A02:6B8::1'), '2a02:6b8::1', 'canonicalize lowercases');
eq(canonicalize('1:2:3:4:5:6:7:8'), '1:2:3:4:5:6:7:8', 'canonicalize leaves full form');
eq(canonicalize('nope'), null, 'canonicalize rejects garbage');

// ---------- source normalization ----------
eq(normalize({ ip: '8.8.8.8', cc: 'us' })?.cc, 'US', 'normalize upcases the code');
eq(normalize({ ip: ' 8.8.8.8 ', cc: 'US' })?.ip, '8.8.8.8', 'normalize trims the ip');
eq(normalize({ ip: '8.8.8.8', cc: 'ZZ' })?.cc, null, 'normalize rejects ZZ');
eq(normalize({ ip: '8.8.8.8', cc: 'USA' })?.cc, null, 'normalize rejects three letters');
eq(normalize({ ip: '10.0.0.1', cc: 'US' }), null, 'normalize rejects private ip');
eq(normalize({ ip: 'nope', cc: 'US' }), null, 'normalize rejects garbage ip');
eq(normalize(null), null, 'normalize handles null');

eq(normalize({ ip: '8.8.8.8', cc: 'UK' })?.cc, 'GB', 'normalize maps the UK alias to GB');
eq(normalize({ ip: '8.8.8.8', cc: 'EL' })?.cc, 'GR', 'normalize maps the EL alias to GR');
for (const bogus of ['XX', 'AA', 'QM', 'XK']) {
  eq(normalize({ ip: '8.8.8.8', cc: bogus })?.cc, null, `normalize rejects user-assigned ${bogus}`);
}
eq(normalize({ ip: '[2606:4700::1]', cc: 'US' })?.ip, '2606:4700::1', 'normalize canonicalizes the ip');
eq(normalize({ ip: '2606:4700::1%eth0', cc: 'US' })?.ip, '2606:4700::1', 'normalize strips the zone id');

// Every source parser understands a real-world response body.
const SAMPLES = {
  'country.is': { ip: '109.204.88.1', country: 'BG' },
  'geojs.io': { country: 'BG', country_3: 'BGR', ip: '109.204.88.1', name: 'Bulgaria' },
  'myip.com': { ip: '109.204.88.1', country: 'Bulgaria', cc: 'BG' },
};
eq(SOURCES.length, Object.keys(SAMPLES).length, 'every source has a sample response');
for (const source of SOURCES) {
  const r = normalize(source.parse(SAMPLES[source.id]));
  ok(r?.ip === '109.204.88.1' && r?.cc === 'BG', `${source.id} parses its response`);
  ok(source.url.startsWith('https://'), `${source.id} is queried over https`);
}

// probeSource never throws and reports failures as data.
const probeOk = await probeSource(SOURCES[0], async () => ({ ip: '1.1.1.1', country: 'AU' }));
ok(probeOk.ip === '1.1.1.1' && probeOk.cc === 'AU' && !probeOk.error, 'probeSource success');
const probeFail = await probeSource(SOURCES[0], async () => { throw new Error('boom'); });
ok(probeFail.ip === null && probeFail.error === 'failed', 'probeSource failure');
const probeJunk = await probeSource(SOURCES[0], async () => ({ nothing: true }));
ok(probeJunk.ip === null && probeJunk.error === 'unexpected response', 'probeSource junk body');
for (const body of [null, [], 'text', 42]) {
  const r = await probeSource(SOURCES[0], async () => body);
  eq(r.error, 'unexpected response', `probeSource handles a ${JSON.stringify(body)} body`);
}
eq((await probeSource(undefined, async () => ({}))).id, 'unknown', 'probeSource survives a bad source');

// Error labels are a fixed vocabulary, so response bytes can never reach the UI.
const SECRET = 'SENSITIVE-BODY-CONTENT';
for (const err of [
  new SyntaxError(`Unexpected token 'h', "${SECRET}"... is not valid JSON`),
  new Error(`failed to fetch https://internal.example/${SECRET}`),
  Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
  Object.assign(new Error('Failed to fetch'), { name: 'TypeError' }),
]) {
  const r = await probeSource(SOURCES[0], async () => { throw err; });
  ok(!r.error.includes(SECRET), `error label hides the body (${r.error})`);
  ok(r.error.length < 30, `error label stays short (${r.error})`);
}
eq((await probeSource(SOURCES[0], async () => {
  throw Object.assign(new Error('t'), { name: 'TimeoutError' });
})).error, 'timed out', 'timeout gets a readable label');

// probeAll keeps source order regardless of which resolves first.
const ordered = await probeAll(async (url) => {
  const index = SOURCES.findIndex((s) => s.url === url);
  await new Promise((r) => setTimeout(r, (SOURCES.length - index) * 5));
  return { ip: `1.1.1.${index + 1}`, country: 'AU', cc: 'AU' };
});
eq(ordered.map((r) => r.id).join(','), SOURCES.map((s) => s.id).join(','), 'probeAll preserves order');

// ---------- consensus ----------
const v = (...rows) => consensus(rows.map(([id, ip, cc]) => ({ id, ip, cc })));

let r = v(['a', '1.1.1.1', 'NL'], ['b', '1.1.1.1', 'NL'], ['c', '1.1.1.1', 'NL']);
ok(r.ok && r.cc === 'NL' && r.ip === '1.1.1.1' && !r.conflict && r.strong, 'unanimous agreement');
eq(r.ips.length, 1, 'unanimous: one address');

// Rotating exit pool: same country, different addresses.
r = v(['a', '1.1.1.1', 'BG'], ['b', '2.2.2.2', 'BG'], ['c', '1.1.1.1', 'BG']);
ok(r.cc === 'BG' && !r.conflict && r.strong, 'rotation keeps one country');
eq(r.ips.length, 2, 'rotation: both addresses listed');
ok(r.unanimous && !r.sameIp, 'rotation is unanimous across addresses');

// Majority wins over an outlier, and the outlier raises the conflict flag.
r = v(['a', '1.1.1.1', 'BG'], ['b', '2.2.2.2', 'GB'], ['c', '1.1.1.1', 'BG']);
ok(r.cc === 'BG' && r.conflict && r.strong, 'majority wins, conflict reported');
eq(r.votes, 2, 'majority vote count');
eq(r.total, 3, 'total vote count');
ok(!r.unanimous, 'contested reading is not unanimous');

// One address, two countries: the geo databases disagree, nothing is leaking.
r = v(['a', '1.1.1.1', 'BG'], ['b', '1.1.1.1', 'GB']);
ok(r.conflict && r.sameIp, 'same address, different countries flagged as database disagreement');

// A tie is not a strong result and never promotes on its own.
r = v(['a', '1.1.1.1', 'BG'], ['b', '2.2.2.2', 'GB']);
ok(r.cc === 'BG' && !r.strong && !r.unanimous && r.conflict, 'tie resolves by priority but stays weak');

// Four-way disagreement must never look confirmable, in any source order.
for (const order of [['BG', 'GB', 'NL', 'FR'], ['FR', 'NL', 'GB', 'BG'], ['NL', 'BG', 'FR', 'GB']]) {
  const spread = consensus(order.map((cc, i) => ({ id: `s${i}`, ip: `1.1.1.${i}`, cc })));
  ok(!spread.strong && !spread.unanimous, `4-way split stays unconfirmable (${order.join('/')})`);
  eq(spread.votes, 1, `4-way split has one vote each (${order.join('/')})`);
}

// One lone source is weak, but unanimous - two such checks in a row confirm it.
r = v(['a', '1.1.1.1', 'BG'], ['b', null, null], ['c', null, null]);
ok(r.ok && r.cc === 'BG' && !r.strong && r.unanimous, 'single source is weak but uncontested');
eq(r.responded, 1, 'responded counts reachable sources');
eq(r.probed, 3, 'probed counts every source queried');

// Sources that answered without a country are not counted as agreeing.
r = v(['a', '1.1.1.1', 'NL'], ['b', '1.1.1.1', 'NL'], ['c', '1.1.1.1', null], ['d', null, null]);
ok(r.votes === 2 && r.total === 2 && r.responded === 3 && r.probed === 4, 'vote counts stay separate');

// Reachable source without a country still yields an address.
r = v(['a', '1.1.1.1', null], ['b', null, null]);
ok(r.ok && r.cc === null && r.ip === '1.1.1.1' && !r.strong, 'ip without country');
ok(r.unanimous && !r.conflict, 'no country reported is not a conflict');

// Total failure.
r = v(['a', null, null], ['b', null, null]);
ok(!r.ok && r.cc === null && r.ip === null && r.ips.length === 0, 'all sources failed');
eq(r.probed, 2, 'failed verdict still reports how many were probed');

// The reported address comes from a source that agrees with the winner.
r = v(['a', '9.9.9.9', 'GB'], ['b', '1.1.1.1', 'BG'], ['c', '1.1.1.1', 'BG']);
eq(r.ip, '1.1.1.1', 'address follows the winning country');

// Malformed entries are ignored rather than crashing the vote.
ok(consensus([null, undefined, { id: 'a', ip: '1.1.1.1', cc: 'NL' }]).cc === 'NL', 'consensus skips empty rows');

// The strong threshold is a real majority of the sources that voted.
for (const [best, total, expected] of [[2, 2, true], [2, 3, true], [2, 4, false], [2, 5, false], [3, 4, true], [3, 5, true], [1, 1, false]]) {
  const rows = [];
  for (let i = 0; i < best; i++) rows.push([`w${i}`, `1.1.1.${i}`, 'NL']);
  for (let i = best; i < total; i++) rows.push([`o${i}`, `2.2.2.${i}`, i % 2 ? 'US' : 'FR']);
  eq(v(...rows).strong, expected, `strong for ${best} of ${total}`);
}

// ---------- flags ----------
eq(flagEmoji('nl'), '🇳🇱', 'flagEmoji lowercases');
for (const bad of [null, '', 'N', 'NLD', 'ＮＬ', 42]) {
  eq(flagEmoji(bad), '🌐', `flagEmoji falls back for ${JSON.stringify(bad)}`);
}
eq(countryName('NL'), 'Netherlands', 'countryName resolves a real code');
eq(countryName('XX'), 'XX', 'countryName echoes an unknown code');
eq(countryName('N'), 'N', 'countryName survives an invalid code');
eq(countryName(null), 'Unknown country', 'countryName handles null');
eq(ccColor('NL'), ccColor('NL'), 'ccColor is deterministic');
ok(ccColor('NL') !== ccColor('BG'), 'ccColor separates countries');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
