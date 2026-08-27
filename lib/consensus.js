// Turns several independent source answers into one verdict.
//
// Three situations this has to tell apart, all seen in practice:
//   - sources disagree on the IP but agree on the country: either the exit node
//     uses a pool of addresses, or some services were reached over IPv4 and
//     others over IPv6. Either way the country is the meaningful answer;
//   - sources report different countries for the SAME address: the geo
//     databases simply disagree about that address, which is common for
//     hosting ranges and is not a sign of anything being wrong;
//   - sources report different countries for DIFFERENT addresses: part of the
//     traffic really is leaving through another route, which is worth warning
//     about.

/**
 * @param {Array<{id: string, ip: string|null, cc: string|null, fresh?: boolean}>} results
 *        in priority order (earlier entries win ties)
 */
export function consensus(results) {
  const probed = results.length;
  const ok = results.filter((r) => r && r.ip);
  if (!ok.length) {
    return {
      ok: false, cc: null, ip: null, ips: [], countries: [],
      votes: 0, total: 0, responded: 0, probed,
      conflict: false, sameIp: false, unanimous: false, strong: false,
      staleSockets: false,
    };
  }

  const votes = new Map(); // cc -> number of sources reporting it
  for (const r of ok) {
    if (r.cc) votes.set(r.cc, (votes.get(r.cc) ?? 0) + 1);
  }

  let cc = null;
  let best = 0;
  for (const [code, n] of votes) {
    if (n > best) {
      cc = code;
      best = n;
    }
  }

  // Sources marked fresh are reached over connections opened after the last
  // check (sources.js drops their sockets every time), so they are the only
  // ones certainly speaking over the route in use right now. When they agree
  // with each other and every remaining source reports a different address AND
  // a different country, those others answered down connections Chrome kept
  // alive across a network change: they describe where the browser used to
  // leave from. Their majority is a majority about the past, and the fresh
  // reading takes over.
  //
  // Every clause is load-bearing. One address with several countries is only
  // the geo databases disagreeing, and a rotating exit pool hands out several
  // addresses inside one country; neither means anything is stale. And at least
  // one fresh witness has to have arrived over https, otherwise an answer
  // rewritten in transit could move the country on its own.
  const freshRows = ok.filter((r) => r.fresh && r.cc);
  const freshCc = freshRows.length && freshRows.every((r) => r.cc === freshRows[0].cc)
    ? freshRows[0].cc
    : null;
  const freshIps = new Set(freshRows.map((r) => r.ip));
  const others = ok.filter((r) => !r.fresh && r.cc);
  const staleSockets = Boolean(
    freshCc
    && freshRows.some((r) => r.secure !== false)
    && others.length
    && others.every((r) => r.cc !== freshCc && !freshIps.has(r.ip)),
  );
  if (staleSockets) {
    cc = freshCc;
    best = votes.get(freshCc) ?? freshRows.length;
  }

  const total = [...votes.values()].reduce((a, b) => a + b, 0);
  const ips = [...new Set(ok.map((r) => r.ip))];
  const countries = [...votes.keys()];
  // Prefer an address reported by a source that agrees with the winning country.
  const ip = (ok.find((r) => cc && r.cc === cc) ?? ok[0]).ip;

  return {
    ok: true,
    cc,
    ip,
    ips,
    countries,
    votes: best,
    total,            // sources that reported a country
    responded: ok.length,
    probed,
    conflict: countries.length > 1,
    sameIp: ips.length === 1,
    // The disagreement is explained: the other sources are answering over
    // sockets that outlived a network change, not over a leaking route.
    staleSockets,
    // Nobody contradicted the winner. Two such readings in a row are enough to
    // accept a country change even when only one source is reachable.
    unanimous: countries.length <= 1,
    // An outright majority of the sources that reported a country. This alone
    // is enough to accept a change immediately - and so is a fresh reading that
    // caught the others on stale sockets, since waiting for them to agree would
    // mean waiting for connections that will not be reopened on their own.
    strong: staleSockets || (best >= 2 && best * 2 > total),
  };
}
