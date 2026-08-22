// Flag emoji, country names and toolbar icon rendering.
// Rendering needs OffscreenCanvas, so it only runs in the browser.

const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

/** 'NL' -> '🇳🇱'; an unknown or invalid code -> '🌐'. */
export function flagEmoji(cc) {
  if (!cc || !/^[A-Za-z]{2}$/.test(cc)) return '🌐';
  const up = cc.toUpperCase();
  return String.fromCodePoint(
    0x1f1e6 + up.charCodeAt(0) - 65,
    0x1f1e6 + up.charCodeAt(1) - 65,
  );
}

/** Country name in English, e.g. 'NL' -> 'Netherlands'. */
export function countryName(cc) {
  if (!cc) return 'Unknown country';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc.toUpperCase()) ?? cc;
  } catch {
    return cc;
  }
}

// Whether the rendered bitmap contains colored (non-grey) pixels. Windows draws
// flag emoji as plain letter pairs, and this is how that case is detected.
function looksColored(imageData) {
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 40) continue;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 30) return true;
  }
  return false;
}

// Bounding box of non-transparent pixels, or null when nothing was drawn.
function alphaBounds(imageData) {
  const { data, width, height } = imageData;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] < 16) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function hashHue(str) {
  let h = 0;
  for (const ch of str) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}

/** Stable placeholder color for a country code. */
export function ccColor(cc) {
  // Kept dark enough for white text to clear the 4.5:1 contrast threshold at
  // every hue.
  return cc ? `hsl(${hashHue(cc)} 45% 32%)` : 'hsl(0 0% 38%)';
}

let flagEmojiSupport = null;

/** Whether flag emoji render as actual colored flags (they do not on Windows). */
export function supportsFlagEmoji() {
  if (flagEmojiSupport !== null) return flagEmojiSupport;
  try {
    const canvas = new OffscreenCanvas(24, 24);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.font = `18px ${EMOJI_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🇳🇱', 12, 13);
    flagEmojiSupport = looksColored(ctx.getImageData(0, 0, 24, 24));
  } catch {
    flagEmojiSupport = true; // cannot tell - assume flags work
  }
  return flagEmojiSupport;
}

// Emoji are rendered once at this size and then scaled down, which keeps small
// icons sharp and lets the glyph be measured precisely.
const RENDER_SIZE = 160;

// Keeps the newest few entries of a cache and drops the oldest.
function capCache(cache, limit) {
  while (cache.size > limit) cache.delete(cache.keys().next().value);
}

const glyphCache = new Map();

// Rendering the glyph and scanning its pixels is the expensive part, and it is
// identical for all four icon sizes, so it happens once per country.
function getGlyph(cc) {
  const key = cc ?? '??';
  let glyph = glyphCache.get(key);
  if (!glyph) {
    const canvas = new OffscreenCanvas(RENDER_SIZE, RENDER_SIZE);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.font = `${Math.round(RENDER_SIZE * 0.78)}px ${EMOJI_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(flagEmoji(cc), RENDER_SIZE / 2, RENDER_SIZE / 2);
    const image = ctx.getImageData(0, 0, RENDER_SIZE, RENDER_SIZE);
    glyph = { canvas, box: alphaBounds(image), colored: looksColored(image) };
    glyphCache.set(key, glyph);
    capCache(glyphCache, 8);
  }
  return glyph;
}

function drawBadge(ctx, size, cc) {
  const label = cc ? cc.toUpperCase() : '?';
  ctx.clearRect(0, 0, size, size);
  ctx.beginPath();
  ctx.roundRect(0, size * 0.1, size, size * 0.8, size * 0.16);
  ctx.fillStyle = ccColor(cc);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.round(size * (label.length > 1 ? 0.56 : 0.66))}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, size / 2, size / 2 + size * 0.02);
}

/**
 * Draws a size x size icon: the country flag scaled to span the icon's full
 * width, or a country-code badge when flag emoji are unavailable.
 */
export function drawIcon(cc, size) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const { canvas: glyph, box, colored } = getGlyph(cc);
  // The globe used for an unknown country renders everywhere; a flag only
  // counts as usable when the platform actually painted it as a flag.
  const usable = box && (!cc || (supportsFlagEmoji() && colored));

  if (!usable) {
    drawBadge(ctx, size, cc);
    return ctx.getImageData(0, 0, size, size);
  }

  // Fill the icon edge to edge horizontally and center it vertically.
  const scale = size / box.w;
  const h = Math.min(size, box.h * scale);
  const y = Math.round((size - h) / 2);
  ctx.drawImage(glyph, box.x, box.y, box.w, box.h, 0, y, size, h);
  return ctx.getImageData(0, 0, size, size);
}

const iconCache = new Map();

/** ImageData set for chrome.action.setIcon, covering common display scales. */
export function iconImageData(cc) {
  const key = cc ?? '??';
  let icons = iconCache.get(key);
  if (!icons) {
    icons = {};
    for (const size of [16, 24, 32, 48]) icons[size] = drawIcon(cc, size);
    iconCache.set(key, icons);
    capCache(iconCache, 8);
  }
  return icons;
}
