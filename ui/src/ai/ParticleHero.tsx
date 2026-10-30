import { useEffect, useRef, useState } from "react";

/* Particle text hero: the title dissolves into drifting dust inside a
   soft glow, then gathers back into crisp text. Ported from the
   21st.dev particle-title component (its canvas engine is framework
   agnostic); the Tailwind classes became theme.css (.lb-ai-hero-*)
   and the palette is read live from the M3E color tokens so the
   engine follows the app theme. */

type RGB = [number, number, number];
type Box = { x: number; y: number; w: number; h: number };
type Field = { cx: number; cy: number; rx: number; ry: number };
type Mode = "smoke" | "vortex" | "sand" | "burst" | "sweep" | "absorb";
type Blob = { rgb: RGB; a: number; fx: number; fy: number; fw: number; fh: number };
type Palette = { ink: RGB; page: RGB; blobs: Blob[] };

const MODES: Mode[] = ["smoke", "vortex", "sand", "burst", "sweep", "absorb"];
const TIMING = { hold: 5200, field: 1400, travel: 4200 };
const FONT_STACK = '"Google Sans Flex Variable", "Google Sans", system-ui, sans-serif';

function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => {
  const c = clamp(t);
  return c * c * (3 - 2 * c);
};
const ease = (t: number) => {
  const c = clamp(t);
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
};

function createModeBag(seed: number): () => Mode {
  const r = createRng(seed);
  let bag: Mode[] = [];
  let last: Mode | null = null;
  return () => {
    if (!bag.length) {
      bag = MODES.slice();
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
      if (bag[bag.length - 1] === last)
        [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]];
    }
    last = bag.pop() as Mode;
    return last;
  };
}

function blobStrength(b: Blob, A: Box, x: number, y: number) {
  const bw = b.fw * A.w;
  const bh = b.fh * A.h;
  const cx = A.x + b.fx * A.w + bw / 2;
  const cy = A.y + b.fy * A.h + bh / 2;
  return Math.max(0, 1 - Math.hypot((x - cx) / (bw / 2), (y - cy) / (bh / 2))) * b.a;
}

function rimMask(A: Box, x: number, y: number) {
  const r = Math.hypot((x - (A.x + A.w / 2)) / (A.w / 2), (y - (A.y + A.h / 2)) / (A.h / 2));
  return r < 0.55 ? 1 : r >= 1 ? 0 : 1 - (r - 0.55) / 0.45;
}

function glowAt(pal: Palette, A: Box, x: number, y: number): { c: RGB; s: number } {
  let [r, g, b] = pal.page;
  let vis = 0;
  const m = rimMask(A, x, y);
  for (const bl of pal.blobs) {
    const s = blobStrength(bl, A, x, y) * m;
    r = mix(r, bl.rgb[0], s);
    g = mix(g, bl.rgb[1], s);
    b = mix(b, bl.rgb[2], s);
    vis = Math.max(vis, s);
  }
  return { c: [r, g, b], s: vis };
}

function sampleFieldPoint(pal: Palette, rand: () => number, f: Field, A: Box) {
  let best: { x: number; y: number; c: RGB; s: number } | null = null;
  for (let k = 0; k < 4; k++) {
    const a = rand() * 6.2832;
    const q = Math.pow(rand(), 0.6);
    const x = f.cx + Math.cos(a) * f.rx * q;
    const y = f.cy + Math.sin(a) * f.ry * q;
    const g = glowAt(pal, A, x, y);
    if (!best || g.s > best.s) best = { x, y, c: g.c, s: g.s };
  }
  return best as { x: number; y: number; c: RGB; s: number };
}

type Cell = {
  rx: number;
  ry: number;
  rw: number;
  rh: number;
  hx: number;
  hy: number;
  nx: number;
  ny: number;
  r1: number;
  r2: number;
  r3: number;
  size: number;
  fx: number;
  fy: number;
  fc: RGB;
  lt: number;
  bend: number;
  pa: number;
};
type Phase = "text" | "dissolving" | "field" | "gathering";

function plan(mode: Mode, p: Cell, W: number, H: number) {
  switch (mode) {
    case "smoke":
      return { delay: (1 - clamp(p.ny)) * 0.35 + p.r3 * 0.25, bend: (p.r1 - 0.5) * 150 };
    case "vortex":
      return {
        delay: (Math.hypot(p.hx - W / 2, p.hy - H / 2) / Math.max(1, W)) * 0.9 + p.r3 * 0.15,
        bend: (p.r2 > 0.5 ? 1 : -1) * (90 + p.r1 * 140),
      };
    case "sand":
      return { delay: p.nx * 0.6 + p.r3 * 0.18, bend: (p.r1 - 0.5) * 60 };
    case "burst":
      return { delay: p.r3 * 0.1, bend: (p.r2 - 0.5) * 26 };
    case "sweep":
      return { delay: (1 - p.nx) * 0.6 + p.r3 * 0.18, bend: -(60 + p.r1 * 90) };
    default:
      return { delay: p.r1 * 0.55, bend: (p.r2 - 0.5) * 100 };
  }
}

function bowAt(a: [number, number], b: [number, number], bend: number, t: number) {
  const e = ease(t);
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L = Math.hypot(dx, dy) || 1;
  const bow = Math.sin(e * Math.PI) * bend;
  return [mix(a[0], b[0], e) + (-dy / L) * bow, mix(a[1], b[1], e) + (dx / L) * bow, e] as const;
}

const rgbStr = (a: RGB, b: RGB, t: number) => {
  const c = (i: number) => Math.max(0, Math.min(255, Math.round(mix(a[i], b[i], t))));
  return "rgb(" + c(0) + "," + c(1) + "," + c(2) + ")";
};

type Engine = { setActive: (on: boolean) => void; resize: () => void; destroy: () => void };

const INTRO_LEAD = 0.08;

function createEngine(cv: HTMLCanvasElement, text: string, pal: Palette): Engine | null {
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  const textCv = document.createElement("canvas");
  const nextMode = createModeBag((Date.now() & 0xffff) ^ 0x5a5a);
  let W = 0;
  let H = 0;
  let dpr = 1;
  let field: Field = { cx: 0, cy: 0, rx: 0, ry: 0 };
  let box: Box = { x: 0, y: 0, w: 0, h: 0 };
  let parts: Cell[] = [];
  let phase: Phase = "gathering";
  let mode: Mode = nextMode();
  let phaseStart = 0;
  let raf = 0;
  let timer = 0;
  let intro = true;
  let active = true;
  let destroyed = false;

  function reroll() {
    const r = createRng((Math.random() * 1e9) | 0);
    for (const p of parts) {
      const q = sampleFieldPoint(pal, r, field, box);
      p.fx = q.x;
      p.fy = q.y;
      p.fc = q.c;
    }
  }

  function build() {
    W = cv.clientWidth;
    H = cv.clientHeight;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.max(1, Math.round(W * dpr));
    cv.height = Math.max(1, Math.round(H * dpr));
    textCv.width = cv.width;
    textCv.height = cv.height;
    ctx!.setTransform(1, 0, 0, 1, 0, 0);
    const ty = H / 2;
    box = { x: 0, y: 0, w: W, h: H };
    field = { cx: W / 2, cy: H / 2, rx: Math.min(560, W * 0.4), ry: Math.min(260, H * 0.3) };
    const o = textCv.getContext("2d") as CanvasRenderingContext2D;
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    o.clearRect(0, 0, W, H);
    let fs = W >= 1100 ? 38 : Math.max(24, Math.min(38, W * 0.05));
    o.font = "500 " + fs + "px " + FONT_STACK;
    o.textAlign = "center";
    o.textBaseline = "middle";
    /* Long hero sentences shrink to fit instead of clipping. */
    let m = o.measureText(text);
    if (m.width > W * 0.92) {
      fs = Math.max(15, Math.floor(fs * ((W * 0.92) / m.width)));
      o.font = "500 " + fs + "px " + FONT_STACK;
      m = o.measureText(text);
    }
    const tx = W / 2 - (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2;
    o.fillStyle = "rgba(" + pal.ink.join(",") + ",.95)";
    o.fillText(text, tx, ty);
    const tw = m.width;
    const X0 = Math.max(0, Math.floor((tx - tw / 2 - 6) * dpr));
    const X1 = Math.min(cv.width, Math.ceil((tx + tw / 2 + 6) * dpr));
    const Y0 = Math.max(0, Math.floor((ty - fs) * dpr));
    const Y1 = Math.min(cv.height, Math.ceil((ty + fs) * dpr));
    const d = o.getImageData(0, 0, cv.width, cv.height).data;
    let cs = Math.max(2, Math.round(3 * dpr));
    let pts: number[][];
    for (;;) {
      pts = [];
      for (let y = Y0; y < Y1; y += cs)
        for (let x = X0; x < X1; x += cs) {
          const w = Math.min(cs, cv.width - x);
          const h = Math.min(cs, cv.height - y);
          let hit = false;
          for (let yy = y; yy < y + h && !hit; yy++)
            for (let xx = x; xx < x + w; xx++)
              if (d[(yy * cv.width + xx) * 4 + 3] > 0) {
                hit = true;
                break;
              }
          if (hit) pts.push([x, y, w, h]);
        }
      if (pts.length <= 2400) break;
      cs++;
    }
    let minX = 1e9;
    let maxX = -1e9;
    for (const p of pts) {
      p[4] = (p[0] + p[2] / 2) / dpr;
      p[5] = (p[1] + p[3] / 2) / dpr;
      if (p[4] < minX) minX = p[4];
      if (p[4] > maxX) maxX = p[4];
    }
    const r = createRng(7);
    parts = pts.map((p) => {
      const u = r();
      const size = u < 0.62 ? 0.9 + r() * 0.8 : u < 0.9 ? 1.8 + r() * 1.4 : 3.4 + r() * 3.2;
      return {
        rx: p[0],
        ry: p[1],
        rw: p[2],
        rh: p[3],
        hx: p[4],
        hy: p[5],
        nx: (p[4] - minX) / Math.max(1, maxX - minX),
        ny: (p[5] - (ty - fs / 2)) / fs,
        r1: r(),
        r2: r(),
        r3: r(),
        size,
        fx: 0,
        fy: 0,
        fc: [0, 0, 0] as RGB,
        lt: 0,
        bend: 0,
        pa: 0,
      };
    });
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    reroll();
  }

  function drawRealText() {
    const c = ctx as CanvasRenderingContext2D;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, cv.width, cv.height);
    c.globalAlpha = 1;
    c.drawImage(textCv, 0, 0);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function frame(now: number) {
    raf = 0;
    const c = ctx as CanvasRenderingContext2D;
    const lead = intro && phase === "gathering" ? INTRO_LEAD : 0;
    const prog = clamp((now - phaseStart) / TIMING.travel + lead);
    const out = phase === "dissolving";
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, cv.width, cv.height);
    for (const p of parts) {
      const pl = plan(mode, p, W, H);
      const lt = clamp((prog - pl.delay * 0.55) / 0.45);
      p.lt = lt;
      p.bend = pl.bend;
      p.pa = out ? 1 - smooth(lt / 0.18) : smooth((lt - 0.82) / 0.18);
      if (p.pa <= 0.002) continue;
      c.globalAlpha = p.pa;
      c.drawImage(textCv, p.rx, p.ry, p.rw, p.rh, p.rx, p.ry, p.rw, p.rh);
    }
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const p of parts) {
      const lt = p.lt;
      if (lt <= 0 || lt >= 1) continue;
      const a: [number, number] = out ? [p.hx, p.hy] : [p.fx, p.fy];
      const b: [number, number] = out ? [p.fx, p.fy] : [p.hx, p.hy];
      const q = bowAt(a, b, out ? p.bend : -p.bend, lt);
      const e = out ? q[2] : 1 - q[2];
      let alpha = 0.1 + 0.9 * (1 - smooth((e - 0.45) / 0.55));
      alpha *= out ? 1 - smooth((lt - 0.85) / 0.15) : smooth(lt / 0.15) * (1 - p.pa);
      if (alpha <= 0.004) continue;
      c.globalAlpha = Math.min(1, alpha);
      c.fillStyle = rgbStr(pal.ink, p.fc, smooth(e / 0.6));
      c.beginPath();
      c.arc(q[0], q[1], (p.size * mix(1, 1.7, smooth(e))) / 2, 0, 6.2832);
      c.fill();
    }
    c.globalAlpha = 1;
    if (prog < 1) raf = requestAnimationFrame(frame);
    else advance();
  }

  function stopWork() {
    clearTimeout(timer);
    cancelAnimationFrame(raf);
    raf = 0;
  }

  function enter(next: Phase) {
    phase = next;
    phaseStart = performance.now();
    stopWork();
    if (!active || destroyed) return;
    if (next === "text") {
      intro = false;
      drawRealText();
      timer = window.setTimeout(advance, TIMING.hold);
    } else if (next === "field") {
      ctx!.setTransform(1, 0, 0, 1, 0, 0);
      ctx!.clearRect(0, 0, cv.width, cv.height);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      timer = window.setTimeout(advance, TIMING.field);
    } else {
      if (next === "dissolving") {
        mode = nextMode();
        reroll();
      }
      frame(performance.now());
    }
  }

  function advance() {
    enter(
      phase === "text"
        ? "dissolving"
        : phase === "dissolving"
          ? "field"
          : phase === "field"
            ? "gathering"
            : "text"
    );
  }

  build();
  enter("gathering");
  return {
    setActive(on) {
      if (on === active || destroyed) return;
      active = on;
      if (on) enter(phase);
      else stopWork();
    },
    resize() {
      if (destroyed) return;
      stopWork();
      build();
      if (active) enter(phase);
      else if (phase === "text") drawRealText();
    },
    destroy() {
      destroyed = true;
      active = false;
      stopWork();
    },
  };
}

/* Palette from the live M3E tokens, read where the canvas sits so a
   scoped theme still applies. Computed colors resolve to rgb(); hex
   tokens parse too; anything else falls back to the dark palette. */
function tokenRgb(el: Element, name: string, fallback: RGB): RGB {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  let m = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  m = v.match(/^#([0-9a-fA-F]{6})$/);
  if (m)
    return [
      parseInt(m[1].slice(0, 2), 16),
      parseInt(m[1].slice(2, 4), 16),
      parseInt(m[1].slice(4, 6), 16),
    ];
  return fallback;
}

function paletteOn(el: Element): Palette {
  return {
    ink: tokenRgb(el, "--md-sys-color-on-surface", [244, 244, 246]),
    page: tokenRgb(el, "--md-sys-color-surface", [12, 12, 14]),
    blobs: [
      { rgb: tokenRgb(el, "--md-sys-color-primary", [86, 112, 160]), a: 0.5, fx: 0.04, fy: 0.08, fw: 0.62, fh: 0.78 },
      { rgb: tokenRgb(el, "--md-sys-color-tertiary", [140, 130, 190]), a: 0.3, fx: 0.44, fy: 0.22, fw: 0.54, fh: 0.7 },
      { rgb: tokenRgb(el, "--md-sys-color-secondary", [150, 104, 84]), a: 0.34, fx: 0.3, fy: 0.44, fw: 0.44, fh: 0.56 },
    ],
  };
}

function usePrefersReducedMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduce(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduce;
}

export function ParticleHero({ text }: { text: string }) {
  const reduce = usePrefersReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = canvasRef.current;
    if (reduce || !cv) return;
    const engine = createEngine(cv, text, paletteOn(cv));
    if (!engine) return;
    let visible = true;
    let size = cv.clientWidth + "x" + cv.clientHeight;
    const sync = () => engine.setActive(visible && !document.hidden);
    const io = new IntersectionObserver((entries) => {
      visible = entries[entries.length - 1].isIntersecting;
      sync();
    });
    io.observe(cv);
    let rz = 0;
    const ro = new ResizeObserver(() => {
      const next = cv.clientWidth + "x" + cv.clientHeight;
      if (next === size) return;
      size = next;
      clearTimeout(rz);
      rz = window.setTimeout(() => engine.resize(), 200);
    });
    ro.observe(cv);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      document.removeEventListener("visibilitychange", sync);
      clearTimeout(rz);
      io.disconnect();
      ro.disconnect();
      engine.destroy();
    };
  }, [reduce, text]);

  return (
    <div className="lb-ai-hero">
      <div className="lb-ai-hero-glow" aria-hidden={true}>
        <span className="lb-ai-hero-blob lb-ai-hero-b1"></span>
        <span className="lb-ai-hero-blob lb-ai-hero-b2"></span>
        <span className="lb-ai-hero-blob lb-ai-hero-b3"></span>
      </div>
      {!reduce && (
        <canvas ref={canvasRef} aria-hidden={true} className="lb-ai-hero-cv"></canvas>
      )}
      <h2 className={reduce ? "lb-ai-hero-txt" : "lb-ai-hero-sr"}>{text}</h2>
    </div>
  );
}
