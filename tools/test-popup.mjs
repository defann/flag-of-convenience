// Exercise the actual popup script with controllable storage, worker and paint
// queues. No real network or timing thresholds: a worker can stay pending for
// as long as needed without preventing the saved reading from being displayed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { flagEmoji, countryName, ccColor } from '../lib/flags.js';

const script = (await readFile(new URL('../popup/popup.js', import.meta.url), 'utf8'))
  .replace(/^import .+;$/m, '');
const turn = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const reading = (cc, checkedAt = Date.now()) => ({
  cc, stableCc: cc, checkedAt, ips: ['1.1.1.1'], votes: 2, responded: 2,
  sources: [{ id: 'example', ip: '1.1.1.1', cc }],
});
const cached = {
  state: reading('NL'),
  history: [{ at: Date.now() - 60_000, from: 'GB', to: 'NL' }],
  settings: { intervalMin: 5 },
};

function element() {
  const classes = new Set();
  return {
    children: [], listeners: {}, style: {}, dataset: {}, value: '',
    set textContent(value) { this.text = value; this.children = []; },
    get textContent() { return this.text ?? ''; },
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
    },
    append(...nodes) { this.children.push(...nodes); },
    setAttribute() {},
    addEventListener(type, callback) { this.listeners[type] = callback; },
  };
}

function open({ storage = Promise.resolve(cached), platform = 'MacIntel', emoji = true } = {}) {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  get('hero-country').textContent = 'Checking…';
  get('interval').value = '15';
  get('error-box').classList.add('hidden');
  const frames = [], timers = [], messages = [];
  const worker = deferred();
  let changed, probes = 0;
  vm.runInNewContext(script, {
    flagEmoji, countryName, ccColor,
    supportsFlagEmoji: () => { probes++; return emoji; },
    navigator: { platform },
    document: { getElementById: get, createElement: element },
    chrome: {
      storage: {
        local: { get: () => storage },
        onChanged: { addListener: (callback) => { changed = callback; } },
      },
      runtime: {
        sendMessage: (msg) => {
          messages.push(msg);
          return msg.type === 'getState' || msg.type === 'refresh' ? worker.promise : Promise.resolve();
        },
      },
    },
    requestAnimationFrame: (callback) => frames.push(callback),
    setTimeout: (callback) => timers.push(callback),
    clearTimeout() {}, setInterval() {},
  }, { filename: 'popup.js' });
  return {
    get, frames, timers, messages, worker,
    get probes() { return probes; },
    change: (changes) => changed(changes, 'local'),
    async paint() {
      assert.equal(frames.length, 1, 'initial paint is scheduled');
      frames.shift()();
      assert.equal(probes, 0, 'font detection does not block the paint callback');
      timers.shift()();
      await turn();
    },
  };
}

// A sleeping worker cannot hold up the country, IPs, sources or settings.
{
  const popup = open();
  await turn();
  assert.equal(popup.get('hero-country').textContent, 'Netherlands (NL)');
  assert.equal(popup.get('ips').children[0].children[0].textContent, '1.1.1.1');
  assert.equal(popup.get('sources').children.length, 1);
  assert.equal(popup.get('history').children.length, 1);
  assert.equal(popup.get('interval').value, '5');
  assert.equal(popup.probes, 0, 'no synchronous canvas readback during initialization');
  assert.equal(popup.messages.length, 0, 'worker wakes only after the saved UI can paint');
  await popup.paint();
  assert.equal(popup.messages[0].type, 'getState', 'opening still requests stale-data refresh and clears the dot');
  assert.equal(popup.probes, 1);

  const next = { ...reading('DE', cached.state.checkedAt + 1000), lastChange: { at: Date.now(), from: 'NL', to: 'DE' } };
  popup.change({ state: { oldValue: cached.state, newValue: next } });
  assert.equal(popup.get('hero-country').textContent, 'Germany (DE)', 'live updates still render');
  assert.equal(popup.messages.at(-1).type, 'changeSeen', 'live country changes are acknowledged');
  popup.worker.resolve(cached);
  await turn();
  assert.equal(popup.get('hero-country').textContent, 'Germany (DE)', 'late worker replies cannot replace a newer reading');
}

// A slow disk snapshot must not erase a live update or a user's actions.
{
  const disk = deferred();
  const popup = open({ storage: disk.promise });
  popup.change({ state: { newValue: reading('FR', cached.state.checkedAt + 1000) } });
  popup.get('clear-history').listeners.click();
  popup.get('interval').value = '60';
  popup.get('interval').listeners.change();
  disk.resolve(cached);
  await turn();
  assert.equal(popup.get('hero-country').textContent, 'France (FR)');
  assert.equal(popup.get('history').children.length, 0);
  assert.equal(popup.get('interval').value, '60');
}

// First installation and a failed direct read both retain the worker fallback.
for (const unavailable of [false, true]) {
  const storage = unavailable ? Promise.reject(new Error('storage unavailable')) : Promise.resolve({});
  const popup = open({ storage });
  await turn();
  assert.equal(popup.get('hero-country').textContent, 'Checking…');
  assert.equal(popup.get('interval').value, '15');
  await popup.paint();
  popup.worker.resolve(cached);
  await turn();
  assert.equal(popup.get('hero-country').textContent, 'Netherlands (NL)');
}

// Cached data remains useful even if waking the worker fails.
{
  const popup = open();
  await turn();
  await popup.paint();
  popup.worker.reject(new Error('worker unavailable'));
  await turn();
  assert.equal(popup.get('hero-country').textContent, 'Netherlands (NL)');
  assert.equal(popup.get('error-box').classList.contains('hidden'), false);
}

// Windows gets its country-code badge on the very first render. Other systems
// can still fall back when the deferred capability check detects missing flags.
for (const platform of ['Win32', 'Linux x86_64']) {
  const popup = open({ platform, emoji: false });
  await turn();
  assert.equal(popup.get('hero-flag').textContent, platform === 'Win32' ? 'NL' : '🇳🇱');
  await popup.paint();
  assert.equal(popup.get('hero-flag').textContent, 'NL');
  assert.equal(popup.get('hero-flag').classList.contains('as-badge'), true);
}

console.log('Popup startup and update regression tests passed');
