/* Collapsible tool row: the 21st.dev thinking-tool pattern
   hand-ported onto M3E tokens, no dependencies. A one-line summary
   shimmers while the step runs and settles to a static label once
   done; the detail area expands under it. Shared by the reasoning
   stream and by tool calls such as the Exa web search, so every
   assistant step renders with the same anatomy. */
import { useEffect, useRef, useState, type ReactNode } from "react";

interface ToolRowProps {
  label: string;
  doneLabel: string;
  active: boolean;
  children?: ReactNode;
}

export function ToolRow({ label, doneLabel, active, children }: ToolRowProps) {
  const hasBody = children != null;
  const [open, setOpen] = useState(active);
  /* Track manual toggles: an untouched row auto-expands while the
     step runs and auto-folds when it settles; a user-opened row
     keeps its state across the transition. */
  const touched = useRef(false);
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
      </button>
      {open && hasBody && <div className="lb-ai-tool-body">{children}</div>}
    </div>
  );
}
