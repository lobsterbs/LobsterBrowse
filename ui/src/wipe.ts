/* Shape wipe (demo uv): a real M3E shape grows from the tapped point,
   the change lands at its peak, then the shape fades out. Reduced motion,
   or a wipe already running, just applies the change. */
const SHAPES = ["soft-burst", "sunny", "flower", "12-sided-cookie", "very-sunny", "9-sided-cookie", "burst"];
const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
let busy = false;

export function shapeWipe(r: DOMRect, go: () => void, colour?: string) {
  if (busy || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    go();
    return;
  }
  let el = document.getElementById("lb-wipe");
  if (!el) {
    el = document.createElement("div");
    el.id = "lb-wipe";
    el.setAttribute("aria-hidden", "true");
    el.innerHTML = '<m3e-shape name="soft-burst"></m3e-shape>';
    (document.querySelector("m3e-theme") ?? document.body).appendChild(el);
  }
  const w = el;
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const sc = (Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) * 2.2 / 240) * 1.5;
  w.firstElementChild!.setAttribute("name", SHAPES[Math.floor(Math.random() * SHAPES.length)]);
  w.style.setProperty("--x", x + "px");
  w.style.setProperty("--y", y + "px");
  w.style.setProperty("--sc", sc.toFixed(1));
  if (colour) w.style.setProperty("--wc", colour);
  else w.style.removeProperty("--wc");
  w.className = "wipe";
  w.hidden = false;
  busy = true;
  void (async () => {
    await sleep(20);
    w.classList.add("in");
    await sleep(430);
    try {
      go();
    } finally {
      await sleep(120);
      w.classList.add("out");
      await sleep(450);
      w.hidden = true;
      w.className = "wipe";
      busy = false;
    }
  })();
}
