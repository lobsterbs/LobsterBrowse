import { useEffect, useRef } from "react";

/* Home background. One of two looks, picked at random once per page
   load (so every visit gets one, a reload can flip it). Backdrop only:
   no content, pointer-transparent, behind everything in the view. */
const KIND: "aurora" | "shapes" = Math.random() < 0.5 ? "aurora" : "shapes";

const NAMES = ["soft-burst", "sunny", "flower", "4-leaf-clover", "9-sided-cookie", "puffy", "pentagon", "gem", "heart", "6-sided-cookie", "very-sunny", "oval", "arch", "boom"];
const COL = ["primary-container", "tertiary-container", "secondary-container"];
/* [left %, top %, size px]; scattered clear of the centre column. */
const POS: Array<[number, number, number]> = [[6, 12, 70], [86, 8, 54], [14, 66, 90], [90, 58, 76], [4, 40, 40], [93, 30, 36], [26, 86, 44], [72, 88, 60], [38, 6, 34], [62, 4, 40], [46, 94, 30], [78, 74, 34], [10, 90, 36], [95, 88, 46]];

export default function HomeBg() {
  const ref = useRef<HTMLDivElement>(null);

  /* Shapes lean a little toward the pointer. rAF-throttled, off under
     reduced motion. */
  useEffect(() => {
    const el = ref.current;
    if (KIND !== "shapes" || !el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const move = (e: PointerEvent) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        el.style.setProperty("--px", (e.clientX / innerWidth - 0.5).toFixed(3));
        el.style.setProperty("--py", (e.clientY / innerHeight - 0.5).toFixed(3));
      });
    };
    addEventListener("pointermove", move);
    return () => { removeEventListener("pointermove", move); cancelAnimationFrame(raf); };
  }, []);

  return (
    <div className={"lb-home-bg lb-home-bg-" + KIND} ref={ref} aria-hidden={true}>
      {KIND === "aurora"
        ? [0, 1, 2].map((i) => <i key={i} />)
        : POS.map(([x, y, s], i) => (
            <span key={i} style={{ left: x + "%", top: y + "%", ["--d" as string]: ((s / 5) * (i % 2 ? 1 : -1)).toFixed(1) + "px" }}>
              <m3e-shape
                name={NAMES[i]}
                style={{
                  ["--m3e-shape-size" as string]: s + "px",
                  ["--m3e-shape-container-color" as string]: `var(--md-sys-color-${COL[i % 3]})`,
                  ["--o" as string]: (0.16 + (i % 4) * 0.05).toFixed(2),
                  ["--t" as string]: 14 + (i % 5) * 4 + "s",
                  ["--dl" as string]: "-" + (i * 1.7).toFixed(1) + "s",
                }}
              />
            </span>
          ))}
    </div>
  );
}
