/* Wave 77: the parameters and helpers for the ASCII-art
   background (the 21st.dev "my" recipe reimplementation). The exact
   recipe JSON lives below unchanged; toneMap, bayerAt and charsFor
   are the pure helpers the canvas component and the tests share. */
export type TonePoint = { x: number; y: number };

export type AsciiParams = {
  renderMode: string;
  bgMode: string;
  bgBlur: number;
  bgOpacity: number;
  cellSize: number;
  coverage: number;
  invert: boolean;
  styleBlend: string;
  charSet: string;
  customChars: string;
  brightness: number;
  contrast: number;
  edgeEmphasis: number;
  density: number;
  toneCurve: TonePoint[];
  tint: string;
  tintOpacity: number;
  overlayBlend: string;
  saturation: number;
  grayscale: number;
  blurType: string;
  blurAmount: number;
  blurAngle: number;
  directionalBothSides: boolean;
  tiltFocus: number;
  tiltPosition: number;
  tiltFeather: number;
  lensFocus: number;
  blurCenterX: number;
  blurCenterY: number;
  progressivePosition: number;
  progressiveReverse: boolean;
  pfx: {
    vignette: { enabled: boolean; intensity: number };
    scanLines: { enabled: boolean; intensity: number };
    chromatic: { enabled: boolean; intensity: number };
    bloom: { enabled: boolean; intensity: number };
    filmGrain: { enabled: boolean; intensity: number };
    glitch: { enabled: boolean; intensity: number };
    pixelate: { enabled: boolean; intensity: number };
    halftone: { enabled: boolean; intensity: number };
    filmDust: { enabled: boolean; intensity: number };
  };
  animated: boolean;
  animStyle: string;
  animSpeed: { enabled: boolean; intensity: number };
  animIntensity: { enabled: boolean; intensity: number };
  lights: { enabled: boolean; points: { x: number; y: number; r: number; intensity: number }[] };
  mask: { enabled: boolean; tool: string; brushSize: number; showOverlay: boolean; invert: boolean; dataUrl: string | null; shapes: unknown[] };
};

/* The recipe, exactly as specified: dither on a blurred background,
   13px cells, soft-light warm tint, vignette + bloom, ripple
   animation. */
export const ASCII_PARAMS: AsciiParams = {
  renderMode: "dither",
  bgMode: "blur",
  bgBlur: 12,
  bgOpacity: 90,
  cellSize: 13,
  coverage: 100,
  invert: false,
  styleBlend: "source-over",
  charSet: "standard",
  customChars: "",
  brightness: 0,
  contrast: 115,
  edgeEmphasis: 0,
  density: 0,
  toneCurve: [
    { x: 0, y: 0 },
    { x: 1, y: 1 }
  ],
  tint: "#d8b46a",
  tintOpacity: 38,
  overlayBlend: "soft-light",
  saturation: 100,
  grayscale: 28,
  blurType: "off",
  blurAmount: 35,
  blurAngle: 0,
  directionalBothSides: false,
  tiltFocus: 35,
  tiltPosition: 50,
  tiltFeather: 15,
  lensFocus: 40,
  blurCenterX: 50,
  blurCenterY: 50,
  progressivePosition: 55,
  progressiveReverse: false,
  pfx: {
    vignette: { enabled: true, intensity: 55 },
    scanLines: { enabled: false, intensity: 40 },
    chromatic: { enabled: false, intensity: 15 },
    bloom: { enabled: true, intensity: 45 },
    filmGrain: { enabled: false, intensity: 30 },
    glitch: { enabled: false, intensity: 20 },
    pixelate: { enabled: false, intensity: 15 },
    halftone: { enabled: false, intensity: 20 },
    filmDust: { enabled: false, intensity: 20 }
  },
  animated: true,
  animStyle: "ripple",
  animSpeed: { enabled: true, intensity: 100 },
  animIntensity: { enabled: true, intensity: 60 },
  lights: { enabled: false, points: [] },
  mask: { enabled: false, tool: "freehand", brushSize: 30, showOverlay: false, invert: false, dataUrl: null, shapes: [] }
};

/* Piecewise-linear tone curve: monotone interpolation over the
   control points, clamped to 0..1 outside the curve. */
export function toneMap(v: number, curve: TonePoint[]): number {
  const pts = [...curve].sort((a, b) => a.x - b.x);
  if (pts.length === 0) return v;
  if (v <= pts[0].x) return pts[0].y;
  if (v >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
  for (let i = 1; i < pts.length; i++) {
    if (v <= pts[i].x) {
      const a = pts[i - 1];
      const b = pts[i];
      const span = b.x - a.x;
      const t = span > 0 ? (v - a.x) / span : 0;
      return a.y + (b.y - a.y) * t;
    }
  }
  return v;
}

/* 4x4 Bayer ordered-dither matrix, 0..15 (row y, column x). */
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5]
];

export function bayerAt(x: number, y: number): number {
  return BAYER[((y % 4) + 4) % 4][((x % 4) + 4) % 4];
}

/* Glyph pools for the "characters" render mode. customChars wins
   when non-empty; unknown set names fall back to the standard
   ramp. (Unicode escapes keep this file ASCII-only: some transports
   corrupt literal non-ASCII bytes.) */
export const CHAR_SETS: Record<string, string> = {
  standard: " .:-=+*#%@",
  minimal: " .-+*#",
  binary: "01",
  blocks: "\u2591\u2592\u2593\u2588",
  arrows: " .\u2192\u2197\u2191\u21D1"
};

export function charsFor(P: { charSet: string; customChars: string }): string[] {
  const custom = P.customChars && P.customChars.length > 0 ? P.customChars : null;
  if (custom) return Array.from(custom);
  const set = CHAR_SETS[P.charSet] ?? CHAR_SETS.standard;
  return Array.from(set);
}
