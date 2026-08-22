# Privacy Policy — Flag of Convenience

_Last updated: 22 August 2026_

## What this extension does

Flag of Convenience tells you which country your outbound internet traffic appears to
come from. To do that it asks a small set of public "what is my IP" services
what address and country they see, and shows the resulting country's flag on the
toolbar icon. Those checks run on your chosen interval, at browser start, when
you press Refresh, and when you open a new tab (at most once every 30 seconds).

## What data is involved

1. **Your public IP address and its country.** These are returned to the
   extension by the third-party services listed below. Because any HTTP request
   necessarily reveals the requesting IP address, those services observe your IP
   address in the ordinary course of answering. The extension sends them nothing
   else.
2. **Your two settings** — check interval and the notification toggle.
3. **A capped list of the last 20 country changes** — timestamp, previous
   country, new country. IP addresses are deliberately not stored in this list.

## Where the data goes

All of the above is stored only in `chrome.storage.local`, on your own device.
None of it is transmitted to the developer or to any analytics, advertising, or
telemetry service. The developer operates no server and receives no data from
this extension. There is no account, no identifier, and no tracking.

## Third-party services

Each check contacts these endpoints over HTTPS:

- `https://api.country.is/` — country.is
- `https://get.geojs.io/v1/ip/country.json` — GeoJS
- `https://api.myip.com/` — myip.com

Requests are GET only, are sent with `credentials: 'omit'`, and carry no
cookies, no page content, and no browsing history. Each service's own privacy
policy governs what it does with the request it receives.

## What this extension never does

It requests no access to any website — it holds no host permissions at all. It
cannot read, modify, or observe the pages you visit, your browsing history, your
bookmarks, your downloads, your form data, or your credentials. It has no
content scripts. Opening a new tab starts a check, but the extension is told
only that a tab was created: it holds no `tabs` permission, so the tab's URL,
title and favicon are not part of the event it receives, and nothing about the
tab is stored or sent anywhere.

## Data retention and deletion

Nothing is retained off-device. To delete everything stored locally, use the
"Clear" button next to the country-change history in the popup, or remove the
extension from `chrome://extensions`.

## Limited Use

The use of information received from this extension adheres to the Chrome Web
Store User Data Policy, including the Limited Use requirements. Data is used
solely to provide the single user-facing feature described above. It is never
sold, never transferred to third parties except as needed to provide that
feature, never used for advertising or personalization, and never subjected to
human review.

## Changes

If data practices change, this page will be updated and the change described in
the extension's Chrome Web Store listing before the update ships.

## Contact

<!-- Replace with the contact address you want published. -->
