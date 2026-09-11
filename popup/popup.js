import { flagEmoji, countryName, supportsFlagEmoji, ccColor } from '../lib/flags.js';

const $ = (id) => document.getElementById(id);

// Windows Chrome does not draw flag emoji, so fall back to country codes there.
const FLAGS_OK = supportsFlagEmoji();
const flag = (cc) => (FLAGS_OK ? flagEmoji(cc) : '');
// Joined with a no-break space, so a flag never ends up on a line without its
// code. trim() strips it again when there is no flag to join.
const withFlag = (cc) => `${flag(cc)}\u00a0${cc}`.trim();

let current = { state: null, history: [], settings: null };

// Race guard: a late sendMessage reply must not overwrite fresher data that
// already arrived through storage.onChanged. A backwards clock step is let
// through, otherwise the popup would freeze until wall-clock time caught up.
let stateTs = 0;
const tsOf = (st) => Math.max(st?.checkedAt ?? 0, st?.errorAt ?? 0);

function acceptData(state, history) {
  const ts = tsOf(state);
  if (ts < stateTs && stateTs - ts < 60_000) return;
  stateTs = ts;
  current.state = state ?? null;
  current.history = history ?? [];
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString(undefined, {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function fmtAgo(ts) {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 10) return 'just now';
  if (sec < 60) return `${sec} sec ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  return `on ${fmtTime(ts)}`;
}

// Time left before the resting sources are asked again, as m:ss. It sits at
// 0:00 once the wait is over, until the next check picks them up.
function fmtCooldown(until) {
  if (!until) return '';
  const sec = Math.max(0, Math.ceil((until - Date.now()) / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

let toastTimer = null;

function showToast() {
  const toast = $('toast');
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 1200);
}

async function copyIp(ip) {
  try {
    await navigator.clipboard.writeText(ip);
    showToast();
  } catch {
    // Clipboard unavailable - nothing useful to do.
  }
}

function showMessage(text) {
  const box = $('error-box');
  box.textContent = text;
  box.classList.remove('hidden');
}

function renderIps(state) {
  const box = $('ips');
  box.textContent = '';
  const ips = state.ips?.length ? state.ips : (state.ip ? [state.ip] : []);
  box.classList.toggle('hidden', !ips.length);

  for (const ip of ips) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'ip-row';
    row.title = 'Copy';
    row.setAttribute('aria-label', `Copy IP address ${ip}`);
    const value = document.createElement('span');
    value.className = 'ip-value';
    value.textContent = ip;
    const cc = document.createElement('span');
    cc.className = 'ip-cc';
    // A source that reported this address tells us which country it maps to.
    const src = state.sources?.find((s) => s.ip === ip && s.cc);
    cc.textContent = src ? withFlag(src.cc) : '';
    row.append(value, cc);
    row.addEventListener('click', () => copyIp(ip));
    box.append(row);
  }

  const note = $('rotation-note');
  // When the countries themselves disagree, the warning above already explains
  // the several addresses; repeating "the country is reliable" would contradict it.
  if (ips.length > 1 && !state.conflict) {
    note.textContent = `${ips.length} exit addresses seen in this check — services can reach you over IPv4 and IPv6, or a VPN pool may rotate addresses. The country is the reliable signal.`;
    note.classList.remove('hidden');
  } else {
    note.classList.add('hidden');
  }
}

function renderSources(state) {
  const section = $('sources-section');
  const list = $('sources');
  list.textContent = '';
  if (!state.sources?.length) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  for (const s of state.sources) {
    const li = document.createElement('li');
    const id = document.createElement('span');
    id.className = 's-id';
    id.textContent = s.id;
    const val = document.createElement('span');
    val.className = 's-val';
    if (s.ip) {
      val.textContent = s.cc ? `${s.ip}\u00a0·\u00a0${withFlag(s.cc)}` : s.ip;
    } else if (s.skipped) {
      // Left alone on purpose: its connection can only close while nothing is
      // asking it anything, and a connection that never closes keeps answering
      // over the route that was current when it was opened. Until it is asked
      // again, what it said last time stands next to the countdown.
      const last = s.last;
      if (last?.ip) {
        // Only the space before the countdown is breakable: a reading that no
        // longer fits beside it moves down as a whole.
        val.textContent = last.cc ? `${last.ip}\u00a0·\u00a0${withFlag(last.cc)}` : last.ip;
      } else {
        val.classList.add('failed');
        val.textContent = last?.error ? `unavailable (${last.error})` : 'not checked yet';
      }
      const cooldown = document.createElement('span');
      cooldown.className = 's-cooldown';
      cooldown.dataset.until = String(state.nextFullCheckAt ?? 0);
      cooldown.textContent = ` ${fmtCooldown(state.nextFullCheckAt)}`;
      val.append(cooldown);
    } else {
      val.classList.add('failed');
      val.textContent = `unavailable (${s.error ?? 'error'})`;
    }
    li.append(id, val);
    list.append(li);
  }
}

function renderHistory(history) {
  const section = $('history-section');
  const list = $('history');
  list.textContent = '';
  if (!history.length) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  for (const h of history.slice(0, 10)) {
    const li = document.createElement('li');
    const time = document.createElement('span');
    time.className = 'h-time';
    time.textContent = fmtTime(h.at);
    const change = document.createElement('span');
    change.className = 'h-change';
    change.textContent = `${withFlag(h.from)} → ${withFlag(h.to)}`;
    change.title = `${countryName(h.from)} → ${countryName(h.to)}`;
    li.append(time, change);
    list.append(li);
  }
}

function renderSettings(settings) {
  if (!settings) return;
  const select = $('interval');
  select.value = String(settings.intervalMin);
  if (!select.value) select.value = String(15); // stored value no longer offered
}

function render() {
  const { state, history, settings } = current;
  renderSettings(settings);

  if (!state) {
    $('hero-country').textContent = 'Checking…';
    return;
  }

  // The icon and the headline follow the confirmed country; a single unproven
  // reading should not rename the country under the user.
  const shown = state.stableCc ?? state.cc ?? null;
  const hero = $('hero-flag');
  if (FLAGS_OK || !shown) {
    hero.textContent = flagEmoji(shown); // 🌐 exists on every platform
    hero.classList.remove('as-badge');
    hero.style.background = '';
  } else {
    hero.textContent = shown;
    hero.classList.add('as-badge');
    hero.style.background = ccColor(shown);
  }
  $('hero-country').textContent = shown ? `${countryName(shown)} (${shown})` : 'Unknown country';

  const answered = state.responded ?? state.sources?.filter((s) => s.ip).length ?? 0;
  $('hero-sub').textContent = state.cc && answered > 1
    ? `${state.votes} of ${answered} sources that answered agree`
    : 'the country sites see you from';

  const errBox = $('error-box');
  if (state.error) {
    errBox.textContent = `${state.error}.${state.checkedAt ? ` Showing the reading from ${fmtTime(state.checkedAt)}.` : ''}`;
    errBox.classList.remove('hidden');
  } else {
    errBox.classList.add('hidden');
  }

  const conflict = $('conflict-box');
  const countries = (state.countries ?? []).join(', ');
  if (state.staleSockets) {
    // Not a leak: the odd sources out were reached over connections the browser
    // opened before the network changed and has been keeping alive since.
    conflict.textContent = `Some sources still answer over connections opened before your network last changed (${countries}). The country comes from the source whose connection is reopened for every check.`;
    conflict.classList.remove('hidden');
  } else if (state.conflict && state.sameIp) {
    // One address, several answers: the geo databases disagree, nothing is wrong.
    conflict.textContent = `Sources disagree about this address (${countries}). Geo databases often differ on hosting ranges.`;
    conflict.classList.remove('hidden');
  } else if (state.conflict) {
    conflict.textContent = `⚠️ Sources see different countries (${countries}) on different addresses — some of your traffic may be bypassing your VPN or proxy.`;
    conflict.classList.remove('hidden');
  } else {
    conflict.classList.add('hidden');
  }

  renderIps(state);
  renderSources(state);
  renderHistory(history);
  $('checked-at').textContent = state.checkedAt ? `Checked ${fmtAgo(state.checkedAt)}` : 'Not checked yet';
}

async function send(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch {
    return null;
  }
}

async function load(msg) {
  const res = await send(msg);
  if (res && !res.failure) {
    acceptData(res.state, res.history);
    current.settings = res.settings ?? current.settings;
    render();
    return true;
  }
  showMessage(res?.failure
    ? `Could not refresh: ${res.failure}`
    : 'The extension background is not responding. Try reopening the popup.');
  return false;
}

$('refresh').addEventListener('click', async () => {
  const btn = $('refresh');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    await load({ type: 'refresh' });
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh';
  }
});

$('clear-history').addEventListener('click', () => {
  current.history = [];
  renderHistory(current.history);
  send({ type: 'clearHistory' });
});

$('interval').addEventListener('change', () => {
  const intervalMin = Number($('interval').value);
  current.settings = { ...current.settings, intervalMin }; // keep the UI steady
  send({ type: 'setSettings', settings: { intervalMin } });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.state || changes.history) {
    acceptData(
      changes.state ? changes.state.newValue : current.state,
      changes.history ? changes.history.newValue : current.history,
    );
  }
  if (changes.settings) current.settings = { ...current.settings, ...changes.settings.newValue };
  render();

  // A change of country that lands while the popup is open is being looked at
  // right now, so the icon must not keep the dot for it until the next visit.
  const before = changes.state?.oldValue?.lastChange?.at;
  const after = changes.state?.newValue?.lastChange?.at;
  if (after && after !== before) send({ type: 'changeSeen' });
});

setInterval(() => {
  if (current.state?.checkedAt) {
    $('checked-at').textContent = `Checked ${fmtAgo(current.state.checkedAt)}`;
  }
}, 10_000);

setInterval(() => {
  for (const el of document.querySelectorAll('.s-cooldown')) {
    el.textContent = ` ${fmtCooldown(Number(el.dataset.until))}`;
  }
}, 1000);

// Opening the popup is also what marks the latest country change as seen: the
// background takes the dot off the icon when it answers this.
load({ type: 'getState' });
