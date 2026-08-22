#!/usr/bin/env node
/**
 * Renders the Chrome Web Store listing assets from the real popup.
 *
 * Produces store/screenshot-*.png (1280x800) and store/promo-small.png
 * (440x280) by loading the actual popup UI in headless Chrome with mocked
 * extension data, so the screenshots can never drift from the shipped UI.
 *
 *   npm run assets
 */

import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STORE = join(ROOT, 'store');
const PORT = 8951;

const CHROME = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const now = Date.now();

// Mocked extension state per screenshot. The popup itself is untouched.
const SCENES = {
  main: {
    state: {
      ip: '109.204.88.1', cc: 'BG', stableCc: 'BG',
      ips: ['109.204.88.1'], countries: ['BG'], conflict: false, sameIp: true,
      votes: 2, total: 2, responded: 2,
      sources: [
        { id: 'country.is', ip: '109.204.88.1', cc: 'BG', error: null },
        { id: 'geojs.io', ip: '109.204.88.1', cc: 'BG', error: null },
        { id: 'myip.com', ip: null, cc: null, error: 'timed out' },
      ],
      checkedAt: now - 42_000, error: null, errorAt: null,
    },
    history: [
      { at: now - 5_400_000, from: 'NL', to: 'BG' },
      { at: now - 86_400_000, from: 'DE', to: 'NL' },
    ],
    settings: { intervalMin: 15, notify: true },
  },
  rotation: {
    state: {
      ip: '45.87.213.19', cc: 'NL', stableCc: 'NL',
      ips: ['45.87.213.19', '185.199.108.153'], countries: ['NL'],
      conflict: false, sameIp: false, votes: 3, total: 3, responded: 3,
      sources: [
        { id: 'country.is', ip: '45.87.213.19', cc: 'NL', error: null },
        { id: 'geojs.io', ip: '185.199.108.153', cc: 'NL', error: null },
        { id: 'myip.com', ip: '45.87.213.19', cc: 'NL', error: null },
      ],
      checkedAt: now - 8_000, error: null, errorAt: null,
    },
    history: [{ at: now - 1_800_000, from: 'DE', to: 'NL' }],
    settings: { intervalMin: 15, notify: true },
  },
  leak: {
    state: {
      ip: '91.108.12.45', cc: 'CH', stableCc: 'CH',
      ips: ['91.108.12.45', '77.244.32.8'], countries: ['CH', 'DE'],
      conflict: true, sameIp: false, votes: 2, total: 3, responded: 3,
      sources: [
        { id: 'country.is', ip: '91.108.12.45', cc: 'CH', error: null },
        { id: 'geojs.io', ip: '77.244.32.8', cc: 'DE', error: null },
        { id: 'myip.com', ip: '91.108.12.45', cc: 'CH', error: null },
      ],
      checkedAt: now - 15_000, error: null, errorAt: null,
    },
    history: [],
    settings: { intervalMin: 5, notify: true },
  },
};

const SHOTS = [
  {
    file: 'screenshot-1-country.png',
    scene: 'main',
    title: 'Which country are you browsing from?',
    body: 'The flag of your exit IP sits in the toolbar. One glance tells you the VPN is up and where it lands.',
  },
  {
    file: 'screenshot-2-sources.png',
    scene: 'rotation',
    title: 'Three sources, one answer',
    body: 'Services go down and VPN pools rotate addresses. Every check asks three independent services and takes the majority, so one flaky answer cannot flip your flag.',
  },
  {
    file: 'screenshot-3-leak.png',
    scene: 'leak',
    title: 'Spots traffic leaving the tunnel',
    body: 'When sources see different countries on different addresses, part of your traffic is taking another route. The toolbar badge says so.',
  },
];

const PAGE_CSS = `
  * { box-sizing: border-box; margin: 0; }
  body {
    width: 1280px; height: 800px; display: flex; align-items: center; gap: 64px;
    padding: 0 72px; overflow: hidden;
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: linear-gradient(135deg, #eef2ff 0%, #e0e7ff 45%, #dbeafe 100%);
    color: #101828;
  }
  .copy { flex: 1; }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 28px; }
  .brand img { width: 40px; height: 40px; }
  .brand span { font-size: 17px; font-weight: 600; color: #3730a3; letter-spacing: 0.01em; }
  h1 { font-size: 44px; line-height: 1.12; font-weight: 680; letter-spacing: -0.02em; }
  p { font-size: 19px; line-height: 1.55; color: #475467; margin-top: 20px; max-width: 30ch; }
  .frame {
    flex: none; border-radius: 16px; overflow: hidden; background: #fff;
    box-shadow: 0 30px 70px rgba(16, 24, 40, 0.22), 0 3px 10px rgba(16, 24, 40, 0.1);
  }
  iframe { display: block; border: 0; width: 340px; transform-origin: top left; }
`;

function page({ title, body, scene, scale = 1.5 }) {
  return `<!doctype html><meta charset="utf-8"><style>${PAGE_CSS}
  .frame { width: ${Math.round(340 * scale)}px; height: 400px; }
  iframe { height: 400px; transform: scale(${scale}); }
  </style>
  <body>
    <div class="copy">
      <div class="brand"><img src="icons/icon128.png" alt=""><span>My IP Flag</span></div>
      <h1>${title}</h1>
      <p>${body}</p>
    </div>
    <div class="frame"><iframe src="popup/popup.html?scene=${scene}"></iframe></div>
  <script>
    // The popup fills in asynchronously, so keep re-measuring and fit the frame
    // to whatever it ends up needing. Same origin, so the document is readable.
    const scale = ${scale};
    const frame = document.querySelector('.frame');
    const iframe = document.querySelector('iframe');
    let best = 0;
    setInterval(() => {
      const doc = iframe.contentDocument;
      const app = doc && doc.getElementById('app');
      if (!app) return;
      const h = Math.ceil(app.getBoundingClientRect().height) + 14;
      if (h <= best) return;
      best = h;
      iframe.style.height = h + 'px';
      frame.style.height = Math.round(h * scale) + 'px';
    }, 150);
  </script>
  </body>`;
}

const PROMO = `<!doctype html><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body {
    width: 440px; height: 280px; overflow: hidden;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 14px; text-align: center;
    font: 16px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: linear-gradient(135deg, #eef2ff 0%, #dbeafe 100%); color: #101828;
  }
  img { width: 76px; height: 76px; }
  h1 { font-size: 30px; font-weight: 680; letter-spacing: -0.02em; }
  p { font-size: 15px; color: #475467; max-width: 34ch; }
  .flags { font-size: 26px; letter-spacing: 4px; margin-top: 2px; }
</style>
<body>
  <img src="icons/icon128.png" alt="">
  <h1>My IP Flag</h1>
  <p>The flag of the country your traffic comes from, right in the toolbar.</p>
  <div class="flags">🇳🇱 🇩🇪 🇧🇬 🇨🇭 🇯🇵</div>
</body>`;

// The popup reads its data through chrome.runtime; this stands in for it.
function stub() {
  return `const SCENES = ${JSON.stringify(SCENES)};
const scene = new URLSearchParams(location.search).get('scene') || 'main';
const data = SCENES[scene];
window.chrome = {
  runtime: { sendMessage: async () => data },
  storage: { onChanged: { addListener() {} } },
  permissions: { request: async () => true, contains: async () => true },
};`;
}

function waitForExit(child) {
  return new Promise((resolve) => child.on('exit', resolve));
}

async function shoot(url, out, width, height, staging) {
  const args = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    `--user-data-dir=${join(staging, 'chrome-profile')}`,
    `--screenshot=${out}`, `--window-size=${width},${height}`,
    '--virtual-time-budget=5000', url,
  ];
  const child = spawn(CHROME, args, { stdio: 'ignore' });
  // Chrome does not always exit on its own in headless mode; poll for the file.
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const { size } = await stat(out);
      if (size > 0) break;
    } catch {
      // not written yet
    }
  }
  child.kill();
  await waitForExit(child);
  await stat(out); // throws if the screenshot never appeared
}

async function main() {
  const staging = await mkdtemp(join(tmpdir(), 'my-ip-flag-assets-'));
  await mkdir(STORE, { recursive: true });

  for (const dir of ['popup', 'lib', 'icons']) {
    await cp(join(ROOT, dir), join(staging, dir), { recursive: true });
  }
  await writeFile(join(staging, 'popup', 'stub.js'), stub());
  // Load the stub before the popup module so chrome.* exists when it runs.
  const html = await (await import('node:fs/promises')).readFile(join(staging, 'popup', 'popup.html'), 'utf8');
  await writeFile(
    join(staging, 'popup', 'popup.html'),
    html.replace('<script src="popup.js" type="module">', '<script src="stub.js"></script><script src="popup.js" type="module">'),
  );
  for (const shot of SHOTS) await writeFile(join(staging, `${shot.scene}.html`), page(shot));
  await writeFile(join(staging, 'promo.html'), PROMO);

  const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: staging, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));

  try {
    for (const shot of SHOTS) {
      const out = join(STORE, shot.file);
      await rm(out, { force: true });
      await shoot(`http://127.0.0.1:${PORT}/${shot.scene}.html`, out, 1280, 800, staging);
      console.log(`${out} written`);
    }
    const promo = join(STORE, 'promo-small.png');
    await rm(promo, { force: true });
    await shoot(`http://127.0.0.1:${PORT}/promo.html`, promo, 440, 280, staging);
    console.log(`${promo} written`);
  } finally {
    server.kill();
    await rm(staging, { recursive: true, force: true });
  }
  console.log('\nstore/ now holds the listing assets (screenshots 1280x800, promo tile 440x280).');
}

await main();
