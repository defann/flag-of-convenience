# Flag of Convenience

A ship registered abroad sails under a *flag of convenience*. A VPN does the
same thing to your traffic — this extension shows you which flag that is.

A Manifest V3 Chrome extension that shows the flag of the country **your own
traffic appears to come from** — the country websites see you as. Handy for
keeping an eye on a VPN or proxy: when the flag changes, your exit country
changed; when the notification fires, the tunnel probably dropped.

## Features

- The exit country's flag as the toolbar icon, drawn edge to edge so it stays
  readable at 16 px (a country-code badge is used on Windows, where Chrome does
  not render flag emoji).
- Popup with every exit address seen in the current check, what each source
  reported, how many of them agreed, and click-to-copy on each address.
- An optional notification when the exit country changes.
- History of the last 20 country changes, clearable from the popup.
- A `≠` badge when sources see **different countries on different addresses**,
  which suggests part of the traffic is leaving outside the tunnel. Sources
  disagreeing about one single address is just a geo-database difference and is
  reported as such, without the alarm.
- Checks every 1, 5, 15 (default), or 60 minutes, plus a check whenever a new
  tab is opened (at most one every 30 seconds, so a burst of tabs or a session
  restore costs a single check), one at browser start, and a backing-off retry
  (1 → 2 → 5 → 10 → 15 min) while every source is down.

## How it works

Every check queries three independent services in parallel, each returning the
exit IP and its country in one response:

| Source | Endpoint |
| --- | --- |
| country.is | `https://api.country.is/` |
| GeoJS | `https://get.geojs.io/v1/ip/country.json` |
| myip.com | `https://api.myip.com/` |

The country is decided by majority vote, which matters for two reasons found in
practice:

- **Single services go down.** `api.myip.com` was unreachable for hours during
  development; one source is not enough to rely on.
- **Exit IPs rotate.** Behind a VPN pool, two requests a second apart can leave
  through different addresses, and dual-stack services may see you over IPv4 or
  IPv6. No single "current IP" exists, so the popup lists every address that was
  observed instead of picking one arbitrarily.

A country backed by a majority is applied immediately. One that merely went
uncontested — a single reachable source — has to be confirmed by the next check.
A genuinely split reading is never promoted on its own. The toolbar icon follows
the confirmed country, so it does not flicker while sources disagree.

### Privacy properties

- **No host permissions at all.** Every endpoint answers with
  `Access-Control-Allow-Origin: *`, so plain CORS is enough and the extension
  asks for no site access. Install-time permissions are `alarms` and `storage`;
  `notifications` is optional and requested only when you tick the box. The
  new-tab check listens to `chrome.tabs.onCreated`, which needs no permission
  and, without `tabs`, carries no url, title or favicon of that tab.
- No telemetry, no server of the developer's, no account.
- Country-change history stores countries and timestamps, never IP addresses.
- Response text from a service never reaches the UI: failures are reported with
  a fixed vocabulary of labels (`timed out`, `network error`, `HTTP 503`, …).

See [PRIVACY.md](PRIVACY.md) for the policy text to publish alongside a listing.

## Install

The extension is not in the Chrome Web Store yet, so it is installed unpacked.
Chrome deliberately refuses to install a `.zip` or `.crx` that did not come from
the store, so double-clicking the archive will not work — this is the path:

1. Download `flag-of-convenience-<version>.zip` from the
   [latest release](https://github.com/defann/flag-of-convenience/releases/latest).
2. Unzip it, and keep the folder somewhere permanent — Chrome loads the
   extension from that folder on every start, so deleting it uninstalls the
   extension. The folder must have `manifest.json` at its top level.
3. Open `chrome://extensions` and turn on **Developer mode** (top right).
4. Press **Load unpacked** and select the unzipped folder.
5. Optional: click the puzzle-piece icon in the toolbar and pin the extension,
   so the flag is always visible.

The first check runs immediately; the flag replaces the placeholder icon within
a few seconds. To update later, download the new zip, unpack it over the same
folder and press the reload arrow on the extension's card.

Chrome shows a "Disable developer mode extensions" warning at startup for any
unpacked extension. It is about how the extension was installed, not about what
it does, and it goes away once the extension is installed from the store.

### From a clone

```bash
git clone https://github.com/defann/flag-of-convenience.git
```

Then load the cloned folder with **Load unpacked** as above.

Requires Chrome 111 or newer (`chrome.alarms` promises, `AbortSignal.timeout`).

## Development

```bash
npm test      # unit tests for parsing, sources and the consensus rules
npm run icons # regenerate icons/ and the padded store icon
npm run assets# rebuild store screenshots from the real popup
npm run pack  # run tests, then build dist/flag-of-convenience-<version>.zip
```

`npm run pack` stages only the runtime files, so the archive has `manifest.json`
at its root and contains no tests, tooling, or listing assets.

## Layout

```
manifest.json        Manifest V3, minimal permissions
background.js        service worker: polling, icon, notifications
lib/ip.js            IPv4/IPv6 parsing, classification, canonical form
lib/sources.js       endpoint definitions, response parsing and validation
lib/consensus.js     majority vote over the source answers
lib/flags.js         flag emoji, country names, toolbar icon rendering
popup/               popup UI
store/               Chrome Web Store listing assets (not shipped in the zip)
tools/test.mjs       unit tests
tools/make-icons.py  icon generator
tools/make-store-assets.mjs  listing screenshots and promo tile
tools/pack.mjs       upload package builder
```

## Data sources and credits

- **country.is** — free for any use, no quota. Its data includes GeoLite data
  created by MaxMind, available from https://www.maxmind.com.
- **GeoJS** (geojs.io) — free, no rate limits; the default 15-minute interval
  keeps the load to roughly 96 requests per user per day.
- **myip.com** — free with no request limit; the author asks for credit, which
  this section provides.

## License

MIT — see [LICENSE](LICENSE).
