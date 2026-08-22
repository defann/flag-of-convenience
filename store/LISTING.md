# Chrome Web Store submission — Flag of Convenience

Everything the Developer Dashboard asks for, in the order it asks. Copy the
texts as they are. The upload package is built by `npm run pack` and lands in
`dist/flag-of-convenience-<version>.zip` (not versioned in git; it is also
attached to the GitHub release).

## 0. One-time account setup

1. Sign in at <https://chrome.google.com/webstore/devconsole> with the Google
   account that should own the listing. This is permanent in practice: an
   extension cannot be moved to another account, only unpublished and
   re-published under a new ID.
2. Pay the one-time 5 USD registration fee.
3. Fill in the **Account** tab: a contact email, and verify it. An unverified
   contact email blocks publishing.

## 1. Package

Upload `dist/flag-of-convenience-2.1.0.zip` under **Items → Add new item**.

Facts a reviewer will check, and where they come from:

| Field | Value |
| --- | --- |
| Manifest version | 3 |
| Version | 2.1.0 |
| Permissions | `alarms`, `storage` |
| Optional permissions | `notifications` |
| Host permissions | none |
| Content scripts | none |
| Remote code | none |
| Minimum Chrome | 111 |

## 2. Store listing tab

**Name** (45 max)

```
Flag of Convenience
```

**Summary** (132 max — this is `description` in the manifest, prefilled)

```
Shows the flag of the country your traffic appears to come from, an at-a-glance VPN and proxy check in your toolbar.
```

**Description**

```
A ship registered abroad sails under a flag of convenience. A VPN does the same thing to your traffic — Flag of Convenience shows you which flag that is.

The country your traffic appears to come from sits in your toolbar as its flag. One glance tells you whether the tunnel is up and where it comes out, and an optional notification fires the moment that country changes — which is usually the moment a VPN dropped.

WHAT YOU GET

• The exit country's flag as the toolbar icon, drawn edge to edge so it stays readable at 16 px. On Windows, where Chrome does not render flag emoji, a coloured country-code badge is used instead.
• A popup with every exit address seen in the current check, what each source reported, and how many of them agreed. Click an address to copy it.
• An optional notification when the exit country changes.
• A history of the last 20 country changes, clearable at any time.
• A ≠ badge when the sources see different countries on different addresses — a hint that part of your traffic is leaving outside the tunnel.
• Checks every 1, 5, 15 or 60 minutes, at browser start, and when you open a new tab (at most one check every 30 seconds).

HOW THE COUNTRY IS DECIDED

Each check asks three independent public services in parallel — country.is, GeoJS and myip.com — and the country is decided by majority vote. This matters in practice: single services go down for hours, and behind a VPN pool two requests a second apart can leave through different addresses. A country backed by a majority is applied at once; one that merely went uncontested has to be confirmed by the next check, so the icon does not flicker while sources disagree.

PRIVACY

• No host permissions at all. The extension cannot read, modify or observe any page you visit — it has no access to your tabs' content, your history, your bookmarks or your form data, and it has no content scripts.
• No telemetry, no developer server, no account, no identifier. Nothing leaves your device for the developer, ever.
• Everything is stored in local extension storage: two settings, the current reading, and a capped list of country changes that holds countries and timestamps but never IP addresses.
• Notifications are an optional permission, requested only if you tick the box.

Open source, MIT licensed: https://github.com/defann/flag-of-convenience
```

**Category**: `Privacy & Security` (second choice: `Tools`)

**Language**: English (United States)

## 3. Graphic assets

| Slot | File | Size |
| --- | --- | --- |
| Store icon | `store/store-icon128.png` | 128×128 |
| Screenshot 1 | `store/screenshot-1-country.png` | 1280×800 |
| Screenshot 2 | `store/screenshot-2-sources.png` | 1280×800 |
| Screenshot 3 | `store/screenshot-3-leak.png` | 1280×800 |
| Small promo tile | `store/promo-small.png` | 440×280 |

Regenerate them with `npm run assets` after any change to the popup.

## 4. Privacy tab

**Single purpose**

```
The extension has one purpose: to show the user which country their own outbound traffic appears to come from, as a flag on the toolbar icon, so they can see at a glance whether their VPN or proxy is active and where it exits.
```

**Permission justifications**

`alarms`

```
The exit country is re-checked on a schedule the user chooses (1, 5, 15 or 60 minutes), and retried with a growing delay while the IP services are unreachable. A Manifest V3 service worker is shut down when idle, so chrome.alarms is the only way to wake it up for the next check.
```

`storage`

```
Stores, on the device only: the user's two settings (check interval and the notification toggle), the latest reading that the popup and the toolbar icon are drawn from, and a capped list of the last 20 country changes containing timestamps and country codes. Nothing is transmitted anywhere.
```

`notifications` (optional)

```
Used only to tell the user that their exit country has changed, which is the signal that a VPN tunnel dropped. It is an optional permission that is requested at the moment the user ticks the checkbox in the popup, and it is never requested otherwise.
```

Host permissions: none requested — say so if a field asks.

**Remote code**: No, I am not using remote code. The extension executes no code
it did not ship with; it only fetches JSON data over HTTPS.

**Data usage**: nothing is collected. Leave every data category unchecked and
certify the three statements (data is not sold, not used for purposes unrelated
to the single purpose, not used to determine creditworthiness or for lending).

The three public services necessarily observe the requesting IP address in order
to answer — any HTTP request reveals it — but that is the service answering the
user's own request, not the developer collecting anything. This is spelled out
in the privacy policy.

**Privacy policy URL**

```
https://defann.github.io/flag-of-convenience/PRIVACY.html
```

## 5. Distribution tab

- Visibility: Public
- Regions: all
- Price: free

## 6. Submit

Press **Submit for review**. A first submission with no host permissions is
usually reviewed within a few days. After it is published, note the extension ID
and add the store link to the README.

## Updating later

1. Bump `version` in both `manifest.json` and `package.json` (they must match —
   `npm run pack` refuses to build otherwise).
2. `npm run pack`.
3. Upload the new zip to the same item, describe the change, submit.
4. Tag the release on GitHub and attach the same zip.
