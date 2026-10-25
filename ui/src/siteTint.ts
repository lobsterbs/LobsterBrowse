/* #213: favicon-hue toolbar tint. The pure half: RGBA pixels in,
   one dominant hue out. No DOM, no React - the canvas draw and the CSS
   variable live in pages/Browser.tsx, so this module is unit-testable
   with synthetic pixel buffers (tests/site-tint/check.mjs).

   Rules (issue #213): ignore transparent, near-white, near-black and
   low-saturation pixels; weight the vote by saturation and alpha;
   return null when too few colored pixels carry it. Saturation and
   lightness are deliberately NOT taken from the icon: the caller
   normalises them in CSS so the result is always a safe accent. */

const MIN_ALPHA = 24; /* below this the pixel is effectively transparent */
const MIN_SAT = 0.25; /* gray-ish pixels carry no hue worth tinting */
const NEAR_WHITE = 235; /* every channel above this reads as white */
const NEAR_BLACK = 25; /* every channel below this reads as black */
const MIN_COLORED = 4; /* fewer colored pixels than this: no verdict */

export type DominantHue = { hue: number };

/* rgbToHue: hue in degrees [0,360) for an RGB triple. */
function rgbToHue(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  if (max === r) return (((g - b) / d) % 6) * 60;
  if (max === g) return ((b - r) / d + 2) * 60;
  return ((r - g) / d + 4) * 60;
}

/* dominantHue: weighted vote over 10-degree bins, then a weighted
   circular mean inside the winning bin (so 350deg and 5deg average
   near 0, not near 180). */
export function dominantHue(px: Uint8ClampedArray | Uint8Array): DominantHue | null {
  const bins = new Float64Array(36);
  const hues: number[][] = [];
  const weights: number[][] = [];
  for (let i = 0; i < 36; i++) {
    hues.push([]);
    weights.push([]);
  }
  let colored = 0;
  for (let i = 0; i + 3 < px.length; i += 4) {
    const a = px[i + 3];
    if (a < MIN_ALPHA) continue;
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max < NEAR_BLACK || min > NEAR_WHITE) continue;
    const sat = max === 0 ? 0 : (max - min) / max;
    if (sat < MIN_SAT) continue;
    colored++;
    const hue = ((rgbToHue(r, g, b) % 360) + 360) % 360;
    const w = sat * (a / 255);
    const bin = Math.floor(hue / 10) % 36;
    bins[bin] += w;
    hues[bin].push(hue);
    weights[bin].push(w);
  }
  if (colored < MIN_COLORED) return null;
  let best = -1;
  for (let i = 0; i < 36; i++) {
    if (best < 0 || bins[i] > bins[best]) best = i;
  }
  if (best < 0 || bins[best] <= 0) return null;
  let sx = 0;
  let sy = 0;
  for (let k = 0; k < hues[best].length; k++) {
    const rad = (hues[best][k] * Math.PI) / 180;
    sx += Math.cos(rad) * weights[best][k];
    sy += Math.sin(rad) * weights[best][k];
  }
  if (sx === 0 && sy === 0) return null;
  let deg = (Math.atan2(sy, sx) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return { hue: deg };
}
