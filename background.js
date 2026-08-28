// Service worker: periodically asks several public services which IP and
// country they see, then paints the winning country's flag on the toolbar.

import { probeAll, dropConnections } from './lib/sources.js';
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
  const sources = await probeAll(undefined, full ? null : (s) => s.http1);
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
    staleSockets: verdict.staleSockets,
    sources,
    stableCc,
    pendingCc,
    fullCheckAt: full ? Date.now() : prev?.fullCheckAt ?? 0,
    retryStep: 0,
    // Why the last country change went unannounced, if it did. Carried across
    // checks: a reason cleared by the next check a minute later is a reason the
    // user never got to read.
    notifyError: prev?.notifyError ?? null,
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
    state.notifyError = await notifyChange(changedFrom, verdict.cc, verdict.ip);
  }

  await chrome.storage.local.set({ state, history });
  await applyIcon(state);
  return state;
}

// ---------- Notifications ----------

// What the confirmation notification says. It is posted the moment the
// permission is granted, so the very first thing the setting does is prove
// that a banner actually reaches the screen.
const NOTIFY_ON_TITLE = 'Notifications are on';
const NOTIFY_ON_BODY = 'This is what a change of exit country will look like.';

// Every notification gets its own id. A reused id makes Chrome replace the
// earlier notification rather than post a new one, and a replacement arrives
// without a banner while the first one is still in the notification centre -
// which is a country change announced to nobody.
let notificationSeq = 0;

// Promisified by hand rather than awaiting the promise-returning form:
// notifications.create only began returning promises in Chrome 116, below the
// minimum this extension supports, and the callback form is the only one that
// surfaces runtime.lastError - which is exactly where "the notification went
// nowhere" shows up.
function createNotification(options) {
  return new Promise((resolve, reject) => {
    const id = `foc-${Date.now()}-${notificationSeq++}`;
    chrome.notifications.create(id, options, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(id);
    });
  });
}

/**
 * Posts one notification. Returns null on success, or a short sentence saying
 * why it could not be posted: a notification that quietly goes nowhere is the
 * one failure this feature must not have, so the popup is told about it.
 */
async function postNotification(title, message) {
  // The namespace exists only while the optional permission is granted, and a
  // worker that was already running when it was granted keeps the bindings it
  // started with - nothing short of a reload brings the namespace back.
  if (!chrome.notifications) {
    return 'Chrome has not handed the extension its notification API yet. Reload the extension in chrome://extensions.';
  }
  try {
    // The permission can be revoked from chrome://extensions behind our back.
    if (!(await chrome.permissions.contains({ permissions: ['notifications'] }))) {
      return 'Notification access is not granted.';
    }
    await createNotification({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message,
    });
    return null;
  } catch (err) {
    return `Chrome refused the notification: ${String(err?.message ?? err)}`;
  }
}

/**
 * Records why a notification did not arrive, so the popup can say so under the
 * checkbox. Used by the paths outside a check; a check writes the field itself,
 * since its own state write would overwrite anything set here.
 */
async function recordNotifyResult(failure) {
  try {
    const { state } = await chrome.storage.local.get('state');
    if (!state || (state.notifyError ?? null) === (failure ?? null)) return;
    await chrome.storage.local.set({ state: { ...state, notifyError: failure ?? null } });
  } catch {
    // Reporting the failure must not become a second failure.
  }
}

/** Announces a country change. Returns null, or why the notification failed. */
async function notifyChange(from, to, ip) {
  try {
    const { notify } = await getSettings();
    if (!notify) return null;
    const mark = supportsFlagEmoji() ? flagEmoji : () => '';
    const failure = await postNotification(
      'Exit country changed',
      `${mark(from)} ${countryName(from)} → ${mark(to)} ${countryName(to)}\nIP: ${ip}`.trim(),
    );
    if (failure) console.warn('Flag of Convenience: notification not delivered -', failure);
    return failure;
  } catch (err) {
    // A notification failing must never break the check itself.
    console.warn('Flag of Convenience: notification not delivered -', err);
    return null;
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

// Chrome closes the popup the instant the permission prompt opens, so the click
// that asked for notifications is killed mid-await and never gets to save the
// setting - which is how the box could come back unticked after the user had
// just allowed it. The answer arrives here instead, in a context that outlives
// the prompt, and this is where the setting follows it. Granting the permission
// from chrome://extensions turns the setting on the same way; revoking it there
// turns it off.
chrome.permissions.onAdded.addListener((perms) => {
  if (!perms?.permissions?.includes('notifications')) return;
  (async () => {
    await updateSettings({ notify: true });
    // Doubles as proof the channel works end to end: if this banner never
    // shows up, notifications are being dropped outside Chrome's reach - a
    // macOS Focus mode, or Chrome itself lacking system notification access.
    const failure = await postNotification(NOTIFY_ON_TITLE, NOTIFY_ON_BODY);
    if (failure) console.warn('Flag of Convenience: notification not delivered -', failure);
    await recordNotifyResult(failure);
  })().catch(() => {});
});

chrome.permissions.onRemoved.addListener((perms) => {
  if (!perms?.permissions?.includes('notifications')) return;
  updateSettings({ notify: false }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      // Only ever set by a test notification: the popup shows the reason there
      // and then, instead of leaving the user to find out at the next country
      // change that nothing arrives.
      let notifyFailure = null;
      if (msg?.type === 'refresh') {
        await checkNow('manual');
      } else if (msg?.type === 'setSettings') {
        await updateSettings(msg.settings ?? {});
        await ensureAlarm();
      } else if (msg?.type === 'clearHistory') {
        await chrome.storage.local.set({ history: [] });
      } else if (msg?.type === 'testNotify') {
        notifyFailure = await postNotification(NOTIFY_ON_TITLE, NOTIFY_ON_BODY);
        await recordNotifyResult(notifyFailure);
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
        notifyFailure,
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
