/* Demo conversation status row and step cards. One pill shows a
   loader while the turn runs and a check once it settles; its label
   names the phase and the chevron opens the step cards under it. */
import { useState, type ReactNode } from "react";

export function StatRow({
  label,
  done,
  active,
  hasSteps,
  children,
}: {
  label: string;
  done: string;
  active: boolean;
  hasSteps: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="lb-ai-stat-wrap">
      <button
        type="button"
        className={"lb-ai-stat" + (open ? " open" : "")}
        aria-expanded={hasSteps ? open : undefined}
        disabled={!hasSteps}
        onClick={() => setOpen((v) => !v)}
      >
        {active ? (
          <m3e-loading-indicator className="lb-ai-stat-load" />
        ) : (
          <m3e-icon name="check_circle" className="lb-ai-stat-ok" />
        )}
        <span className="lb-ai-stxt" role={active ? "status" : undefined}>
          {active ? label : done}
        </span>
        {hasSteps && <m3e-icon name="keyboard_arrow_down" className="lb-ai-stat-chev" />}
      </button>
      {hasSteps && (
        <div className="lb-ai-steps" hidden={!open}>
          {children}
        </div>
      )}
    </div>
  );
}

export function StepCard({ icon, title, sub, children }: { icon: string; title: string; sub?: string; children?: ReactNode }) {
  return (
    <m3e-card variant="outlined" className="lb-ai-step">
      <div className="lb-ai-tin">
        <m3e-icon name={icon} />
        <div className="lb-ai-tt">
          <b>{title}</b>
          {sub && <span>{sub}</span>}
        </div>
      </div>
      {children && <div className="lb-ai-step-body">{children}</div>}
    </m3e-card>
  );
}
