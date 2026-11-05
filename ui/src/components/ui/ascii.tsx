import { useEffect, useRef } from "react";
import { ASCII_PARAMS, bayerAt, charsFor, toneMap, type AsciiParams } from "../../asciiConfig";

/* Canvas2D reimplementation of the 21st.dev "my" ASCII-art effect
   (wave 77), replacing the old starfield as the app background:
   1. draw the source photo (the Clawd mascot, /clawd-sleep.gif) at
      the target size; bgMode/bgBlur/bgOpacity control what shows
      behind the effect (blurred copy here);
   2. divide the canvas into cellSize px cells and sample each
      cell's average color/luminance (one drawImage into a
      grid-sized sampling canvas does the averaging);
   3. per cell, draw the renderMode's primitive (dither ships:
      Bayer-ordered full-cell fills thresholded by animated
      luminance); coverage/density/invert are respected;
   4. color adjustments (brightness/contrast/saturation/grayscale)
      run at sampling time, then the tint at tintOpacity through the
      overlayBlend, then blurType (off here);
   5. pfx post effects run at their intensity when enabled
      (vignette + bloom here);
   6. lights add glow points; 7. mask reveals the plain photo.
   Animation: ripple modulates the per-cell luminance over time;
   prefers-reduced-motion renders a single static frame. */
export function AsciiBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    const P: AsciiParams = ASCII_PARAMS;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let stop = false;
    let img: HTMLImageElement | null = null;
    let imgReady = false;
    let grid: Uint8ClampedArray | null = null;
    let gw = 0;
    let gh = 0;
    const sampleCanvas = document.createElement("canvas");
    const sctx = sampleCanvas.getContext("2d", { willReadFrequently: true });

    /* Deterministic per-cell hash for coverage and mixed-mode picks. */
    const hash = (x: number, y: number): number => {
      const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
      return h - Math.floor(h);
    };

    const fit = (mode: "cover" | "contain") => {
      const w = canvas.width;
      const h = canvas.height;
      const cover = Math.max(w / img!.width, h / img!.height);
      const contain = Math.min(w / img!.width, h / img!.height);
      const sc = mode === "cover" ? cover : contain;
      return { dw: img!.width * sc, dh: img!.height * sc, ox: (w - img!.width * sc) / 2, oy: (h - img!.height * sc) / 2 };
    };

    const resample = () => {
      const w = Math.max(1, window.innerWidth);
      const h = Math.max(1, window.innerHeight);
      canvas.width = w;
      canvas.height = h;
      if (!imgReady || !sctx) return;
      gw = Math.ceil(w / P.cellSize);
      gh = Math.ceil(h / P.cellSize);
      sampleCanvas.width = gw;
      sampleCanvas.height = gh;
      sctx.clearRect(0, 0, gw, gh);
      sctx.filter =
        "brightness(" + (100 + P.brightness) + "%) contrast(" + P.contrast + "%) saturate(" + P.saturation + "%) grayscale(" + P.grayscale + "%)";
      const f = fit("contain");
      sctx.drawImage(img!, f.ox / P.cellSize, f.oy / P.cellSize, f.dw / P.cellSize, f.dh / P.cellSize);
      sctx.filter = "none";
      grid = sctx.getImageData(0, 0, gw, gh).data;
    };

    const animOffset = (t: number, cx: number, cy: number): number => {
      const sp = P.animSpeed.enabled ? P.animSpeed.intensity / 100 : 0;
      const amp = (P.animIntensity.enabled ? P.animIntensity.intensity / 100 : 0.6) * 0.22;
      switch (P.animStyle) {
        case "wave":
          return amp * Math.sin(cx * 0.15 + t * sp * 3);
        case "pulse":
          return amp * Math.sin(t * sp * 4);
        case "shimmer":
          return amp * Math.sin(cx * 1.7 + t * sp * 8);
        case "flicker":
          return amp * Math.sin(t * sp * 13 + cx * 3.1 + cy * 1.7);
        default:
          return amp * Math.sin(cx * 0.3 + cy * 0.18 + t * sp * 4);
      }
    };

    const drawCell = (t: number, cx: number, cy: number, a: number, col: { r: number; g: number; b: number }) => {
      const cs = P.cellSize;
      const x = cx * cs;
      const y = cy * cs;
      const half = cs / 2;
      const color = "rgb(" + col.r + "," + col.g + "," + col.b + ")";
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      switch (P.renderMode) {
        case "characters": {
          const set = charsFor(P);
          const g = set[Math.min(set.length - 1, Math.floor(a * set.length))];
          if (g === " ") break;
          ctx.font = cs + "px ui-monospace, monospace";
          ctx.fillText(g, x, y + cs);
          break;
        }
        case "hexdump": {
          const g = "0123456789ABCDEF"[Math.min(15, Math.floor(a * 16))];
          ctx.font = cs + "px ui-monospace, monospace";
          ctx.fillText(g, x, y + cs);
          break;
        }
        case "braille": {
          const bits = Math.floor(a * 255) & 0xff;
          ctx.font = cs * 1.4 + "px ui-monospace, monospace";
          ctx.fillText(String.fromCharCode(0x2800 + bits), x, y + cs);
          break;
        }
        case "matrix": {
          const g = hash(cx, Math.floor(t * 6)) < 0.5 ? "0" : "1";
          ctx.fillStyle = a > 0.35 ? "#7cf7a0" : "rgba(70,160,90,0.7)";
          ctx.font = cs + "px ui-monospace, monospace";
          ctx.fillText(g, x, y + cs);
          break;
        }
        case "mosaic":
        case "pixel": {
          const s = Math.max(1, cs * a);
          ctx.fillRect(x + (cs - s) / 2, y + (cs - s) / 2, s, s);
          break;
        }
        case "dots": {
          if (a <= 0.02) break;
          ctx.beginPath();
          ctx.arc(x + half, y + half, Math.max(0.5, half * a), 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case "rings": {
          if (a <= 0.05) break;
          ctx.lineWidth = Math.max(1, cs * 0.12);
          ctx.beginPath();
          ctx.arc(x + half, y + half, half * a, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case "cross": {
          if (a <= 0.05) break;
          const l = cs * a;
          ctx.lineWidth = Math.max(1, cs * 0.14);
          ctx.beginPath();
          ctx.moveTo(x + half - l / 2, y + half);
          ctx.lineTo(x + half + l / 2, y + half);
          ctx.moveTo(x + half, y + half - l / 2);
          ctx.lineTo(x + half, y + half + l / 2);
          ctx.stroke();
          break;
        }
        case "diamond": {
          if (a <= 0.03) break;
          const r = half * a;
          ctx.beginPath();
          ctx.moveTo(x + half, y + half - r);
          ctx.lineTo(x + half + r, y + half);
          ctx.lineTo(x + half, y + half + r);
          ctx.lineTo(x + half - r, y + half);
          ctx.fill();
          break;
        }
        case "triangles": {
          if (a <= 0.03) break;
          const s = cs * a;
          ctx.beginPath();
          ctx.moveTo(x + half, y);
          ctx.lineTo(x + s, y + s);
          ctx.lineTo(x, y + s);
          ctx.fill();
          break;
        }
        case "hexagons": {
          const r = half * Math.max(0.25, a);
          ctx.globalAlpha = 0.4 + a * 0.6;
          ctx.beginPath();
          for (let k = 0; k < 6; k++) {
            const ang = (Math.PI / 3) * k + Math.PI / 6;
            const px = x + half + r * Math.cos(ang);
            const py = y + half + r * Math.sin(ang);
            if (k === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.fill();
          ctx.globalAlpha = 1;
          break;
        }
        case "hearts":
        case "stars": {
          if (a <= 0.05) break;
          ctx.font = cs * 1.3 + "px ui-monospace, monospace";
          ctx.globalAlpha = a;
          ctx.fillText(P.renderMode === "hearts" ? String.fromCharCode(0x2665) : String.fromCharCode(0x2605), x, y + cs);
          ctx.globalAlpha = 1;
          break;
        }
        case "lines": {
          if (a <= 0.04) break;
          const l = cs * a;
          ctx.fillRect(x, y + half - Math.max(0.5, cs * 0.09), l, Math.max(1, cs * 0.18));
          break;
        }
        case "diagonal": {
          if (a <= 0.04) break;
          const l = cs * a;
          ctx.lineWidth = Math.max(1, cs * 0.14);
          ctx.beginPath();
          ctx.moveTo(x, y + cs);
          ctx.lineTo(x + l, y + cs - l);
          ctx.stroke();
          break;
        }
        case "halfblocks": {
          if (a <= 0.02) break;
          ctx.fillRect(x, y + cs * (1 - a), cs, cs * a);
          break;
        }
        case "hatch": {
          const n = Math.floor(a * 4);
          if (n === 0) break;
          ctx.lineWidth = 1;
          for (let k = 0; k < n; k++) {
            const o = (cs / 4) * (k + 1);
            ctx.beginPath();
            ctx.moveTo(x, y + o);
            ctx.lineTo(x + o, y);
            ctx.stroke();
          }
          break;
        }
        case "contour": {
          const band = 1 / 6;
          const frac = a % band;
          if (frac < band * 0.18) {
            ctx.fillRect(x + cs * 0.3, y + cs * 0.3, cs * 0.4, cs * 0.4);
          }
          break;
        }
        case "bubbles": {
          if (a <= 0.05) break;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x + half, y + half, half * a, 0, Math.PI * 2);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(x + half * 0.8, y + half * 0.8, Math.max(0.5, half * a * 0.18), 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case "disco": {
          if (a <= 0.04) break;
          ctx.fillStyle = "hsl(" + Math.floor((hash(cx, cy) * 360 + t * 60) % 360) + " 70% 60%)";
          ctx.globalAlpha = a;
          ctx.beginPath();
          ctx.arc(x + half, y + half, half * 0.8, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
          break;
        }
        case "voxel": {
          if (a <= 0.05) break;
          ctx.fillRect(x, y + cs * (1 - a), cs, cs * a);
          ctx.fillStyle = "rgba(255,255,255,0.18)";
          ctx.fillRect(x, y + cs * (1 - a), cs, Math.max(1, cs * 0.18));
          break;
        }
        case "lego": {
          if (a <= 0.05) break;
          const s = cs * Math.max(0.4, a);
          ctx.fillRect(x + (cs - s) / 2, y + (cs - s) / 2, s, s);
          ctx.beginPath();
          ctx.arc(x + half, y + half, s * 0.2, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case "mixed": {
          /* Rotate the render mode for this one cell draw only;
             a local mode variable keeps the recursion one level
             deep instead of mutating shared config. */
          const keep = P.renderMode;
          const pick = hash(cx, cy);
          const alt = pick < 0.34 ? "dither" : pick < 0.67 ? "dots" : "characters";
          (P as { renderMode: string }).renderMode = alt;
          drawCell(t, cx, cy, a, col);
          (P as { renderMode: string }).renderMode = keep;
          break;
        }
        case "dither":
        default: {
          /* Ordered dithering: the cell fills when its animated
             luminance crosses the Bayer threshold - the recipe's
             newspaper-photo look. */
          const b = (bayerAt(cx, cy) + 0.5) / 16;
          if (a > b) ctx.fillRect(x, y, cs, cs);
          break;
        }
      }
    };

    const draw = (t: number) => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.filter = "none";
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);
      if (!imgReady || !grid) return;
      /* 1. background layer: blurred cover copy of the photo at
         bgOpacity (bgMode "blur"); "photo" draws the plain cover
         copy, "color" a flat fill, "none" keeps the black. */
      if (P.bgMode === "blur" || P.bgMode === "photo") {
        const f = fit("cover");
        ctx.save();
        ctx.globalAlpha = P.bgOpacity / 100;
        if (P.bgMode === "blur") ctx.filter = "blur(" + P.bgBlur + "px) brightness(0.75)";
        ctx.drawImage(img!, f.ox, f.oy, f.dw, f.dh);
        ctx.restore();
      }
      /* 2-3. per-cell shapes from the sampled grid. */
      const cov = P.coverage / 100;
      for (let cy = 0; cy < gh; cy++) {
        for (let cx = 0; cx < gw; cx++) {
          if (cov < 1 && hash(cx, cy) > cov) continue;
          const i = (cy * gw + cx) * 4;
          const col = { r: grid[i], g: grid[i + 1], b: grid[i + 2] };
          let lum = (0.2126 * col.r + 0.7152 * col.g + 0.0722 * col.b) / 255;
          lum = toneMap(lum, P.toneCurve);
          if (P.invert) lum = 1 - lum;
          if (P.density > 0) lum += (P.density / 100) * (lum - 0.5);
          if (P.animated) lum += animOffset(t, cx, cy);
          lum = Math.min(1, Math.max(0, lum));
          if (lum <= 0.01) continue;
          drawCell(t, cx, cy, lum, col);
        }
      }
      /* 4. tint pass through the overlay blend. */
      if (P.tintOpacity > 0) {
        ctx.save();
        ctx.globalCompositeOperation = P.overlayBlend as GlobalCompositeOperation;
        ctx.globalAlpha = P.tintOpacity / 100;
        ctx.fillStyle = P.tint;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      }
      /* 5. post effects. */
      const pfx = P.pfx;
      if (pfx.vignette.enabled) {
        const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.max(w, h) * 0.75);
        g.addColorStop(0, "rgba(0,0,0,0)");
        g.addColorStop(1, "rgba(0,0,0," + pfx.vignette.intensity / 100 + ")");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }
      if (pfx.scanLines.enabled) {
        ctx.save();
        ctx.globalAlpha = pfx.scanLines.intensity / 100;
        ctx.fillStyle = "#000";
        for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);
        ctx.restore();
      }
      if (pfx.halftone.enabled) {
        ctx.save();
        ctx.globalAlpha = pfx.halftone.intensity / 100;
        for (let y = 0; y < h; y += 6) {
          for (let x = 0; x < w; x += 6) {
            ctx.beginPath();
            ctx.arc(x + (y % 12 === 0 ? 3 : 0), y, 1.2, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.restore();
      }
      if (pfx.chromatic.enabled) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        const off = Math.max(1, pfx.chromatic.intensity / 5);
        ctx.globalAlpha = 0.2;
        ctx.drawImage(canvas, -off, 0, w, h);
        ctx.drawImage(canvas, off, 0, w, h);
        ctx.restore();
      }
      if (pfx.pixelate.enabled) {
        const s = Math.max(2, Math.round(pfx.pixelate.intensity / 3));
        const tw = Math.max(1, Math.floor(w / s));
        const th = Math.max(1, Math.floor(h / s));
        sampleCanvas.width = tw;
        sampleCanvas.height = th;
        if (sctx) {
          sctx.drawImage(canvas, 0, 0, tw, th);
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(sampleCanvas, 0, 0, w, h);
          ctx.imageSmoothingEnabled = true;
        }
      }
      if (pfx.filmGrain.enabled || pfx.filmDust.enabled) {
        ctx.save();
        if (pfx.filmGrain.enabled) {
          ctx.fillStyle = "rgba(255,255,255,0.05)";
          const n = Math.floor((pfx.filmGrain.intensity / 100) * (w * h) / 220);
          for (let k = 0; k < n; k++) ctx.fillRect(Math.random() * w, Math.random() * h, 1, 1);
        }
        if (pfx.filmDust.enabled) {
          ctx.fillStyle = "rgba(255,255,255,0.25)";
          const n = Math.floor((pfx.filmDust.intensity / 100) * 60);
          for (let k = 0; k < n; k++) {
            const dw = 1 + Math.random() * 3;
            ctx.fillRect(Math.random() * w, Math.random() * h, dw, dw * 0.4);
          }
        }
        ctx.restore();
      }
      if (pfx.glitch.enabled) {
        const slices = Math.floor(pfx.glitch.intensity / 7);
        for (let k = 0; k < slices; k++) {
          const sy = Math.floor(Math.random() * h);
          const sh = 2 + Math.floor(Math.random() * 10);
          const dx = (Math.random() - 0.5) * pfx.glitch.intensity;
          ctx.drawImage(canvas, 0, sy, w, sh, dx, sy, w, sh);
        }
      }
      if (pfx.bloom.enabled) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = (pfx.bloom.intensity / 100) * 0.55;
        ctx.filter = "blur(" + Math.max(6, P.cellSize) + "px)";
        ctx.drawImage(canvas, 0, 0);
        ctx.restore();
      }
      /* 6. lights: additive glow at normalized points. */
      if (P.lights.enabled) {
        for (const L of P.lights.points) {
          const g = ctx.createRadialGradient(L.x * w, L.y * h, 0, L.x * w, L.y * h, L.r * Math.max(w, h));
          g.addColorStop(0, "rgba(255,236,190," + L.intensity + ")");
          g.addColorStop(1, "rgba(255,236,190,0)");
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, w, h);
        }
      }
      /* 7. mask: reveal the plain photo through the mask image. */
      if (P.mask.enabled && P.mask.dataUrl) {
        const mi = new Image();
        mi.src = P.mask.dataUrl;
        if (mi.complete && mi.naturalWidth > 0) {
          ctx.save();
          ctx.globalCompositeOperation = P.mask.invert ? "destination-out" : "destination-in";
          ctx.drawImage(mi, 0, 0, w, h);
          ctx.restore();
        }
      }
    };

    /* The effect frame rate is capped at ~30fps: the grid is up to
       ~10k cells and the background never needs 60. */
    let last = 0;
    let t0 = performance.now();
    const loop = (now: number) => {
      if (stop) return;
      if (now - last >= 33) {
        last = now;
        draw((now - t0) / 1000);
      }
      raf = requestAnimationFrame(loop);
    };

    const start = () => {
      t0 = performance.now();
      if (reduced) {
        draw(0);
        return;
      }
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);
    };

    const onResize = () => {
      resample();
      if (reduced) draw(0);
    };
    const onVis = () => {
      if (document.hidden) cancelAnimationFrame(raf);
      else if (!reduced && imgReady) start();
    };

    img = new Image();
    img.onload = () => {
      imgReady = true;
      resample();
      start();
    };
    img.src = "/clawd-sleep.gif";

    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);
  return <canvas ref={canvasRef} className="lb-ascii-canvas" aria-hidden={true} />;
}
