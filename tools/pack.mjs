#!/usr/bin/env node
/**
 * Builds the upload package for the Chrome Web Store.
 *
 * Runs the test suite, copies only the files the extension needs at runtime
 * into a staging directory, and zips it as dist/<name>-<version>.zip.
 * Development files (tools, tests, README, package.json, dotfiles) stay out.
 *
 *   npm run pack
 */

import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

// Everything the packaged extension needs, and nothing else.
const INCLUDE = [
  'manifest.json',
  'background.js',
  'LICENSE',
  'lib/ip.js',
  'lib/sources.js',
  'lib/consensus.js',
  'lib/flags.js',
  'popup/popup.html',
  'popup/popup.css',
  'popup/popup.js',
  'icons/icon16.png',
  'icons/icon24.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
];

function run(cmd, args, cwd = ROOT) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function main() {
  const manifest = JSON.parse(await readFile(join(ROOT, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  if (manifest.version !== pkg.version) {
    throw new Error(`version mismatch: manifest ${manifest.version} vs package ${pkg.version}`);
  }
  if (manifest.description.length > 132) {
    throw new Error(`description is ${manifest.description.length} chars, the store allows 132`);
  }

  // Every file the manifest points at must be in the package.
  const referenced = [
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
    manifest.action?.default_popup,
    manifest.background?.service_worker,
  ].filter(Boolean);
  for (const rel of referenced) {
    if (!INCLUDE.includes(rel)) throw new Error(`manifest references ${rel}, which is not packed`);
  }

  process.stdout.write('running tests... ');
  run(process.execPath, ['tools/test.mjs']);
  console.log('ok');

  // Verify every referenced file exists before packing.
  for (const rel of INCLUDE) {
    try {
      await stat(join(ROOT, rel));
    } catch {
      throw new Error(`missing file listed in INCLUDE: ${rel}`);
    }
  }

  const staging = await mkdtemp(join(tmpdir(), 'flag-of-convenience-'));
  for (const rel of INCLUDE) {
    const dest = join(staging, rel);
    await mkdir(dirname(dest), { recursive: true });
    await cp(join(ROOT, rel), dest);
  }

  await mkdir(DIST, { recursive: true });
  const zipName = `${pkg.name}-${manifest.version}.zip`;
  const zipPath = join(DIST, zipName);
  await rm(zipPath, { force: true });
  // -X drops extra file attributes, -r recurses, .* excludes macOS metadata.
  run('zip', ['-X', '-r', zipPath, '.', '-x', '.*', '-x', '__MACOSX/*'], staging);
  await rm(staging, { recursive: true, force: true });

  const { size } = await stat(zipPath);
  console.log(`\n${zipPath}`);
  console.log(`${INCLUDE.length} files, ${(size / 1024).toFixed(1)} KB`);
  console.log(run('unzip', ['-l', zipPath]).trimEnd());
}

await main();
