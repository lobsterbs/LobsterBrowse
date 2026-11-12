/* Collapsible tool row: the 21st.dev thinking-tool pattern
   hand-ported onto M3E tokens, no dependencies. A one-line summary
   shimmers while the step runs and settles to a static label once
   done; the detail area expands under it. Shared by the reasoning
   stream and by tool calls such as the Exa web search, so every
   assistant step renders with the same anatomy. The morphing shape
   (user request 2026-11-12) is functional feedback: it cycles while
   the step runs and settles once done. Only the main thinking row
   passes shape, so the AI view keeps one morphing element. */
import { useEffect, useRef, useState, type ReactNode } from "react";

/* Morph cycle names (verified against the @m3e/web 2.8.2 ShapeName
   union); the m3e-shape name morph is a real clip-path spring. */
const MORPH = ["sunny", "4-leaf-clover", "8-leaf-clover"];

interface ToolRowProps {
  label: string;
  doneLabel: string;
  active: boolean;
  /* Settled step duration in ms; rendered as tabular seconds
     beside the done label when present. */
  duration?: number;
  /* Render the decorative morphing shape (main thinking row only). */
  shape?: boolean;
  children?: ReactNode;
}

export function ToolRow({ label, doneLabel, active, duration, shape, children }: ToolRowProps) {
  const hasBody = children != null;
  const [open, setOpen] = useState(active);
  /* Track manual toggles: an untouched row auto-expands while the
     step runs and auto-folds when it settles; a user-opened row
     keeps its state across the transition. */
  const touched = useRef(false);
  /* Morph tick while the step runs; the shape settles when done. */
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!shape || !active) return;
    const t = setInterval(() => setTick((v) => v + 1), 900);
    return () => clearInterval(t);
  }, [shape, active]);
  useEffect(() => {
    if (active) {
      if (!touched.current) setOpen(true);
    } else if (!touched.current) {
      setOpen(false);
    }
  }, [active]);
  function toggle() {
    touched.current = true;
    setOpen((v) => !v);
  }
  return (
    <div className="lb-ai-tool">
      <button
        type="button"
        className="lb-ai-tool-btn"
        aria-expanded={hasBody ? open : undefined}
        onClick={toggle}
        disabled={!hasBody}
      >
        {shape && (
          <m3e-shape
            {...{ class: "lb-ai-tool-shape" }}
            name={active ? MORPH[tick % MORPH.length] : "4-leaf-clover"}
            aria-hidden={true}
          />
        )}
        {hasBody && (
          <svg
            className={"lb-ai-tool-chev" + (open ? " lb-ai-tool-chev-open" : "")}
            viewBox="0 0 24 24"
            aria-hidden={true}
          >
            <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        <span
          className={active ? "lb-ai-tool-label lb-ai-shimmer" : "lb-ai-tool-label"}
          role={active ? "status" : undefined}
        >
          {active ? label : doneLabel}
        </span>
        {!active && duration != null && duration > 0 && (
          <span className="lb-ai-tool-dur">{(duration / 1000).toFixed(1)}s</span>
        )}
      </button>
      {hasBody && (
        <div className={"lb-ai-tool-body-wrap" + (open ? " lb-open" : "")}>
          <div className="lb-ai-tool-body">{children}</div>
        </div>
      )}
    </div>
  );
}
