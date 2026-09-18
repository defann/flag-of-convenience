// Service worker: periodically asks several public services which IP and
// country they see, then paints the winning country's flag on the toolbar.

import { probeAll, dropConnections } from './lib/sources.js';
import { consensus } from './lib/consensus.js';
import { countryName, iconImageData } from './lib/flags.js';

const CHECK_ALARM = 'ip-check';
const RETRY_ALARM = 'ip-retry';
const HISTORY_LIMIT = 20;
const DEFAULT_SETTINGS = { intervalMin: 15 };
// The intervals the popup offers. A value coming from anywhere else - an older
// build, hand-edited storage - is not trusted with the alarm period.
const INTERVALS = [1, 5, 15, 60];
// A new tab gets a fresh reading, but no more often than this: opening ten tabs
// in a row must not turn into ten rounds of requests to the public services.
const TAB_CHECK_COOLDOWN_MS = 30_000;
// Backoff for the one-shot retry while every source is unreachable, in minutes.
const RETRY_DELAYS = [1, 2, 5, 10, 15];
// How rarely the sources whose connection cannot be forced shut are queried,
// whatever the check interval. Their socket only closes while nothing is asking
// them anything, and a socket that never closes is one that keeps leaving
// through the route that was current when it was opened - which is exactly how
// a source ends up reporting the country from before a VPN was switched on.
// Between these rounds a check rests on the source dropConnections() can close.
const SLOW_SOURCE_GAP_MS = 5 * 60_000;

// ---------- Settings ----------

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  if (!INTERVALS.includes(merged.intervalMin)) merged.intervalMin = DEFAULT_SETTINGS.intervalMin;
  return merged;
}

// Settings writes are serialized: the popup sends one message per control, and
// two overlapping read-modify-write cycles would lose the first change.
let settingsChain = Promise.resolve();

function updateSettings(patch) {
  settingsChain = settingsChain
    .catch(() => {})
    .then(async () => {
      const settings = { ...(await getSettings()), ...patch };
      await chrome.storage.local.set({ settings });
      return settings;
    });
  return settingsChain;
}

// ---------- Checking ----------

let inFlight = null;
// When the last check was started. Only lives as long as the service worker,
// so the stored reading is the fallback after a wake-up.
let lastCheckStarted = 0;

function checkNow(reason) {
  if (!inFlight) {
    lastCheckStarted = Date.now();
    inFlight = doCheck(reason).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/** Fire-and-forget variant: never leaves an unhandled rejection behind. */
function checkInBackground(reason) {
  checkNow(reason).catch(() => {});
}

/** Checks unless the reading in hand is younger than maxAgeMs. */
async function checkIfStale(reason, maxAgeMs) {
  if (Date.now() - lastCheckStarted < maxAgeMs) return;
  const { state } = await chrome.storage.local.get('state');
  const last = Math.max(state?.checkedAt ?? 0, state?.errorAt ?? 0);
  if (last && Date.now() - last < maxAgeMs) return;
  await checkNow(reason);
}

async function doCheck(reason) {
  const stored = await chrome.storage.local.get(['state', 'history']);
  const prev = stored.state ?? null;
  const history = stored.history ?? [];

  const full = !prev?.fullCheckAt || Date.now() - prev.fullCheckAt >= SLOW_SOURCE_GAP_MS;
  const sources = await probeAll(undefined, full ? null : (s) => s.http1, prev?.sources ?? []);
  // Right after the answers are in, and before anything can be waiting on the
  // sockets again: this is what stops the next check from being answered over
  // a connection that predates a VPN switch. See dropConnections().
  await dropConnections().catch(() => {});
  const verdict = consensus(sources);

  if (!verdict.ok) {
    // Every source failed: keep the previous reading, mark it stale and
    // schedule a retry (an alarm is the only thing that wakes an idle service
    // worker back up). The delay grows so a long outage is not hammered.
    const retryStep = Math.min((prev?.retryStep ?? 0) + 1, RETRY_DELAYS.length);
    const state = {
      ...(prev ?? {}),
      sources,
      retryStep,
      error: 'Could not reach any IP service',
      errorAt: Date.now(),
      lastReason: reason,
    };
    await chrome.storage.local.set({ state });
    await applyIcon(state);
    await chrome.alarms.create(RETRY_ALARM, { delayInMinutes: RETRY_DELAYS[retryStep - 1] });
    return state;
  }
  await chrome.alarms.clear(RETRY_ALARM);
  const fullCheckAt = full ? Date.now() : prev.fullCheckAt;

  // Country change detection. stableCc is the country the extension actually
  // believes in: it drives the icon, survives failed checks, and only moves
  // when a reading is trustworthy. A reading backed by a majority is accepted
  // at once; one that nobody contradicted is accepted after a second check
  // agrees; a genuinely split reading never promotes on its own, and neither
  // does one that only the plain-http source stands behind.
  let stableCc = prev?.stableCc ?? null;
  let pendingCc = null;
  let changedFrom = null;

  if (!verdict.cc) {
    pendingCc = prev?.pendingCc ?? null;
  } else if (!verdict.secure) {
    // An answer fetched in the clear can have been rewritten on the way. It is
    // noted, so that an https source saying the same next time completes the
    // pair of readings, but it never moves the icon by itself.
    if (verdict.cc !== stableCc) pendingCc = verdict.cc;
  } else if (!stableCc) {
    stableCc = verdict.cc; // first reading is the baseline, nothing to announce
  } else if (verdict.cc !== stableCc) {
    if (verdict.strong || (verdict.unanimous && prev?.pendingCc === verdict.cc)) {
      changedFrom = stableCc;
      stableCc = verdict.cc;
    } else {
      pendingCc = verdict.cc;
    }
  }

  const state = {
    ip: verdict.ip,
    cc: verdict.cc,
    ips: verdict.ips,
    countries: verdict.countries,
    conflict: verdict.conflict,
    sameIp: verdict.sameIp,
    votes: verdict.votes,
    total: verdict.total,
    responded: verdict.responded,
    staleSockets: verdict.staleSockets,
    sources,
    stableCc,
    pendingCc,
    // The last confirmed change of country, carried across checks: it is what
    // the dot on the icon stands for until the popup has been opened.
    lastChange: prev?.lastChange ?? null,
    fullCheckAt,
    // When the resting sources are due to be asked again. The popup counts
    // down to it next to what each of them said last time.
    nextFullCheckAt: fullCheckAt + SLOW_SOURCE_GAP_MS,
    retryStep: 0,
    checkedAt: Date.now(),
    error: null,
    errorAt: null,
    lastReason: reason,
  };

  if (changedFrom) {
    // The address is deliberately not stored: the country is what this history
    // is about, and IP addresses have no business sitting on disk for days.
    const change = { at: Date.now(), from: changedFrom, to: verdict.cc };
    history.unshift(change);
    history.length = Math.min(history.length, HISTORY_LIMIT);
    state.lastChange = change;
  }

  await chrome.storage.local.set({ state, history });
  await applyIcon(state);
  return state;
}

// ---------- The country change mark ----------
//
// A change of exit country is announced by a red dot on the toolbar icon, not
// by a system notification. A notification needs an optional permission, a
// worker that was handed the API after the grant, and a desktop that lets the
// banner through, and any one of those missing meant a change announced to
// nobody. The dot needs none of that: it is part of the icon the extension
// paints anyway. It stays until the popup is opened, which is how the user says
// they have seen the change.
//
// What has been seen is kept under its own storage key rather than on the
// state: a check writes the state as a whole, and a flag set on it from here
// while a check was in flight would be overwritten by that check's result.

/** Whether the latest change of country has not been looked at yet. */
async function hasUnseenChange(state) {
  if (!state?.lastChange) return false;
  const { changeSeenAt = 0 } = await chrome.storage.local.get('changeSeenAt');
  return state.lastChange.at > changeSeenAt;
}

/** Records that the popup has shown the latest change, and takes the dot off. */
async function markChangeSeen() {
  // A check that is about to land could bring a different country, and the
  // icon must not be painted from the reading it is replacing.
  if (inFlight) await inFlight.catch(() => {});
  const { state } = await chrome.storage.local.get('state');
  if (!(await hasUnseenChange(state))) return;
  // The change's own timestamp, not the clock: a change a later check lands a
  // moment from now stays unseen, whatever the clock does in between.
  await chrome.storage.local.set({ changeSeenAt: state.lastChange.at });
  await applyIcon(state);
}

// ---------- Toolbar icon, title and badge ----------

async function applyIcon(state) {
  // The icon follows the confirmed country, not the raw reading, so it does not
  // flicker while sources disagree. The badge is what reports disagreement.
  const cc = state.stableCc ?? state.cc ?? null;
  const unseen = await hasUnseenChange(state);
  try {
    await chrome.action.setIcon({ imageData: iconImageData(cc, unseen) });
  } catch {
    // Drawing is not critical - the default icon stays in place.
  }
  const country = cc ? `${countryName(cc)} (${cc})` : 'unknown country';
  // The tooltip is where the dot gets explained.
  const from = unseen ? state.lastChange.from : null;
  const changed = from ? ` - changed from ${countryName(from)} (${from})` : '';
  const stale = state.error ? ' - could not refresh' : '';
  await chrome.action.setTitle({ title: `Your IP: ${state.ip ?? '-'} - ${country}${changed}${stale}` });

  let text = '';
  let color = '#e37400';
  if (state.error) {
    text = '!';
  } else if (state.conflict && !state.sameIp && !state.staleSockets) {
    // Different addresses AND different countries: part of the traffic really
    // is taking another route. Sources disagreeing about one single address is
    // just a geo-database difference and gets no badge, and neither does the
    // known-harmless case where the odd ones out are answering over sockets
    // that outlived a network change.
    text = '≠';
    color = '#d93025';
  }
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
}

// ---------- Scheduling and events ----------

async function ensureAlarm() {
  const { intervalMin } = await getSettings();
  await chrome.alarms.create(CHECK_ALARM, {
    periodInMinutes: intervalMin,
    delayInMinutes: intervalMin,
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  // A state object written by an older version has a different shape and would
  // render as a half-empty popup until the next check; drop it. The history
  // format is compatible, so it is kept.
  const { state } = await chrome.storage.local.get('state');
  if (state && !Array.isArray(state.sources)) await chrome.storage.local.remove('state');
  await ensureAlarm();
  checkInBackground('install');
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm().catch(() => {});
  checkInBackground('startup');
});

// A new tab is about to be seen from whatever address is current right now, so
// that is the moment to re-read it. Listening to the event needs no permission
// and tells the extension nothing about the tab beyond its existence: without
// "tabs", the url, title and favicon fields are simply absent.
chrome.tabs.onCreated.addListener(() => {
  checkIfStale('tab', TAB_CHECK_COOLDOWN_MS).catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECK_ALARM) checkInBackground('alarm');
  else if (alarm.name === RETRY_ALARM) checkInBackground('retry');
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'refresh') {
        await checkNow('manual');
      } else if (msg?.type === 'setSettings') {
        await updateSettings(msg.settings ?? {});
        await ensureAlarm();
      } else if (msg?.type === 'clearHistory') {
        await chrome.storage.local.set({ history: [] });
      } else if (msg?.type === 'changeSeen') {
        // The popup was open when a change landed, so it has been seen.
        await markChangeSeen();
      } else if (msg?.type === 'getState') {
        // Opening the popup is how a change gets seen, so the dot comes off
        // here. Not awaited: the popup should not have to wait for a check in
        // flight before it can show the reading it already has.
        markChangeSeen().catch(() => {});
        const { state } = await chrome.storage.local.get('state');
        const { intervalMin } = await getSettings();
        const staleMs = intervalMin * 60_000 * 2;
        if (!state?.checkedAt || state.error || Date.now() - state.checkedAt > staleMs) {
          // Runs in the background; the popup picks it up via storage.onChanged.
          checkInBackground('popup');
        }
      }
      const data = await chrome.storage.local.get(['state', 'history']);
      sendResponse({
        state: data.state ?? null,
        history: data.history ?? [],
        settings: await getSettings(),
      });
    } catch (err) {
      sendResponse({ failure: String(err?.message ?? err) });
    }
  })();
  return true; // sendResponse is called asynchronously
});

// Bootstrap, on every service worker start. Icon and title live in the browser
// process and are lost when the worker's extension is reloaded or re-enabled,
// so they are repainted from the stored reading right away.
(async () => {
  try {
    const { state } = await chrome.storage.local.get('state');
    if (state) await applyIcon(state);
    const alarm = await chrome.alarms.get(CHECK_ALARM);
    if (!alarm) {
      await ensureAlarm();
      checkInBackground('wake');
    }
  } catch {
    // Nothing here is worth failing the worker over.
  }
})();
