// Service worker: periodically asks several public services which IP and
// country they see, then paints the winning country's flag on the toolbar.

import { probeAll } from './lib/sources.js';
import { consensus } from './lib/consensus.js';
import { flagEmoji, countryName, iconImageData, supportsFlagEmoji } from './lib/flags.js';

const CHECK_ALARM = 'ip-check';
const RETRY_ALARM = 'ip-retry';
const HISTORY_LIMIT = 20;
const DEFAULT_SETTINGS = { intervalMin: 15, notify: false };
// The intervals the popup offers. A value coming from anywhere else - an older
// build, hand-edited storage - is not trusted with the alarm period.
const INTERVALS = [1, 5, 15, 60];
// A new tab gets a fresh reading, but no more often than this: opening ten tabs
// in a row must not turn into ten rounds of requests to the public services.
const TAB_CHECK_COOLDOWN_MS = 30_000;
// Backoff for the one-shot retry while every source is unreachable, in minutes.
const RETRY_DELAYS = [1, 2, 5, 10, 15];

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
  const sources = await probeAll();
  const verdict = consensus(sources);

  const stored = await chrome.storage.local.get(['state', 'history']);
  const prev = stored.state ?? null;
  const history = stored.history ?? [];

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

  // Country change detection. stableCc is the country the extension actually
  // believes in: it drives the icon, survives failed checks, and only moves
  // when a reading is trustworthy. A reading backed by a majority is accepted
  // at once; one that nobody contradicted is accepted after a second check
  // agrees; a genuinely split reading never promotes on its own.
  let stableCc = prev?.stableCc ?? null;
  let pendingCc = null;
  let changedFrom = null;

  if (verdict.cc) {
    if (!stableCc) {
      stableCc = verdict.cc; // first reading is the baseline, no notification
    } else if (verdict.cc !== stableCc) {
      if (verdict.strong || (verdict.unanimous && prev?.pendingCc === verdict.cc)) {
        changedFrom = stableCc;
        stableCc = verdict.cc;
      } else {
        pendingCc = verdict.cc;
      }
    }
  } else {
    pendingCc = prev?.pendingCc ?? null;
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
    sources,
    stableCc,
    pendingCc,
    retryStep: 0,
    checkedAt: Date.now(),
    error: null,
    errorAt: null,
    lastReason: reason,
  };

  if (changedFrom) {
    // The address is deliberately not stored: the country is what this history
    // is about, and IP addresses have no business sitting on disk for days.
    history.unshift({ at: Date.now(), from: changedFrom, to: verdict.cc });
    history.length = Math.min(history.length, HISTORY_LIMIT);
    await notifyChange(changedFrom, verdict.cc, verdict.ip);
  }

  await chrome.storage.local.set({ state, history });
  await applyIcon(state);
  return state;
}

async function notifyChange(from, to, ip) {
  try {
    const { notify } = await getSettings();
    if (!notify || !chrome.notifications) return;
    // The permission is optional and can be revoked in chrome://extensions.
    const granted = await chrome.permissions.contains({ permissions: ['notifications'] });
    if (!granted) return;
    const mark = supportsFlagEmoji() ? flagEmoji : () => '';
    await chrome.notifications.create('country-change', {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Exit country changed',
      message: `${mark(from)} ${countryName(from)} → ${mark(to)} ${countryName(to)}\nIP: ${ip}`.trim(),
    });
  } catch {
    // A notification failing must never break the check itself.
  }
}

// ---------- Toolbar icon, title and badge ----------

async function applyIcon(state) {
  // The icon follows the confirmed country, not the raw reading, so it does not
  // flicker while sources disagree. The badge is what reports disagreement.
  const cc = state.stableCc ?? state.cc ?? null;
  try {
    await chrome.action.setIcon({ imageData: iconImageData(cc) });
  } catch {
    // Drawing is not critical - the default icon stays in place.
  }
  const country = cc ? `${countryName(cc)} (${cc})` : 'unknown country';
  const stale = state.error ? ' - could not refresh' : '';
  await chrome.action.setTitle({ title: `Your IP: ${state.ip ?? '-'} - ${country}${stale}` });

  let text = '';
  let color = '#e37400';
  if (state.error) {
    text = '!';
  } else if (state.conflict && !state.sameIp) {
    // Different addresses AND different countries: part of the traffic really
    // is taking another route. Sources disagreeing about one single address is
    // just a geo-database difference and gets no badge.
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
      } else if (msg?.type === 'getState') {
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
