/* The first-run tour overlay: a dimmed scrim (drawn as the huge
   box-shadow of the spotlight hole) plus one M3E card positioned next
   to the step's target element. Division of labor: go(i) puts the
   right view on screen (App: setView / openSettings / newTab),
   onStep(n or null) moves the tour (App state), onClose fires on any
   exit (Exit, Escape, Done) so the ask never nags again. The step
   table and the localStorage answer live in ../tour.ts. */

import { useEffect, useRef, useState } from "react";
import { TOUR_STEPS } from "../tour";

type Props = {
  /* null = idle; otherwise an index into TOUR_STEPS. */
  step: number | null;
  /* Make the step's view visible BEFORE positioning (called on every
     step change). */
  go: (i: number) => void;
  /* Move the tour (next/back index, null = leave). */
  onStep: (n: number | null) => void;
};

/* Viewport rect of the target; null until (unless) it resolves. */
type Rect = { l: number; t: number; w: number; h: number } | null;

export default function Tour(props: Props) {
  const { step } = props;
  const st = step === null ? null : TOUR_STEPS[step];
  const [rect, setRect] = useState<Rect>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const [vp, setVp] = useState({ w: 0, h: 0 });

  useEffect(() => {
    setVp({ w: window.innerWidth, h: window.innerHeight });
  }, []);

  /* View switch first, then wait for the target to mount (the Browser
     view mounts on demand; its paint can land a frame later). Poll
     briefly: a step whose target never resolves renders the centered
     card fallback, never a broken overlay. */
  useEffect(() => {
    if (step === null) return;
    props.go(step);
    setRect(null);
    let tries = 0;
    const sel = TOUR_STEPS[step].target;
    const measure = () => {
      const el = document.querySelector<HTMLElement>(sel);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 1 && r.height < 1) return false;
      setRect({ l: r.left, t: r.top, w: r.width, h: r.height });
      return true;
    };
    if (measure()) return;
    const iv = window.setInterval(() => {
      tries++;
      if (measure() || tries > 60) window.clearInterval(iv);
    }, 100);
    return () => window.clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  /* Keep the hole honest across resize and any scroll (capture: the
     views scroll inside their panes, not on window). */
  useEffect(() => {
    const onAny = () => {
      setVp({ w: window.innerWidth, h: window.innerHeight });
      if (step === null) return;
      const el = document.querySelector<HTMLElement>(TOUR_STEPS[step].target);
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width < 1 && r.height < 1) return;
      setRect({ l: r.left, t: r.top, w: r.width, h: r.height });
    };
    window.addEventListener("resize", onAny);
    window.addEventListener("scroll", onAny, true);
    return () => {
      window.removeEventListener("resize", onAny);
      window.removeEventListener("scroll", onAny, true);
    };
  }, [step]);

  /* Escape leaves like Exit (any exit settles the ask). */
  useEffect(() => {
    if (step === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        props.onStep(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  /* Keyboard users land on the card, not under the scrim. */
  useEffect(() => {
    if (step !== null) cardRef.current?.focus();
  }, [step]);

  if (step === null || !st) return null;

  const last = step === TOUR_STEPS.length - 1;
  /* Hole: 8px of breathing room around the target. */
  const pad = 8;
  const hole = rect
    ? {
        left: Math.max(0, rect.l - pad),
        top: Math.max(0, rect.t - pad),
        width: Math.min(vp.w, rect.w + pad * 2),
        height: rect.h + pad * 2,
      }
    : null;
  /* Card: prefer below the target, flip above when the bottom does not
     fit, clamp inside the viewport; centered when no rect resolved. */
  const cardW = Math.min(360, Math.max(12, vp.w - 24));
  let cardL: number;
  let cardT: number;
  if (rect) {
    cardL = Math.min(Math.max(12, rect.l + rect.w / 2 - cardW / 2), Math.max(12, vp.w - cardW - 12));
    const below = rect.t + rect.h + pad + 12;
    const above = rect.t - pad - 12;
    cardT = below + 200 < vp.h ? below : Math.max(12, above - 210);
  } else {
    cardL = Math.max(12, (vp.w - cardW) / 2);
    cardT = vp.h / 2 - 110;
  }

  return (
    <>
      {/* Scrim: single hit target so nothing under the overlay fires;
          leaving is explicit (Exit / Escape). */}
      <div className="lb-tour-scrim" aria-hidden={true} />
      <div
        className="lb-tour-hole"
        style={
          hole
            ? { left: hole.left + "px", top: hole.top + "px", width: hole.width + "px", height: hole.height + "px", opacity: "1" }
            : { opacity: "0" }
        }
        aria-hidden={true}
      />
      <m3e-card
        {...{
          class: "lb-tour-card",
          ref: cardRef,
          tabIndex: -1,
          role: "dialog",
          "aria-modal": true,
          "aria-label": st.title,
        }}
        style={{ left: cardL + "px", top: cardT + "px", width: cardW + "px" }}
      >
        <span className="lb-tour-step">{"Step " + (step + 1) + " of " + TOUR_STEPS.length}</span>
        <m3e-heading variant="title" size="medium" level={3}>
          {st.title}
        </m3e-heading>
        <p className="lb-tour-body">{st.body}</p>
        <div className="lb-tour-actions">
          {/* Exit is plain text: leaving mid-tour is the quiet option,
              never the primary one. */}
          <m3e-button variant="text" onClick={() => props.onStep(null)}>
            Exit
          </m3e-button>
          <span className="lb-tour-nav">
            {step > 0 && (
              <m3e-button onClick={() => props.onStep(step - 1)}>Back</m3e-button>
            )}
            {last ? (
              <m3e-button variant="filled" onClick={() => props.onStep(null)}>
                Done
              </m3e-button>
            ) : (
              <m3e-button variant="filled" onClick={() => props.onStep(step + 1)}>
                Next
              </m3e-button>
            )}
          </span>
        </div>
      </m3e-card>
    </>
  );
}
