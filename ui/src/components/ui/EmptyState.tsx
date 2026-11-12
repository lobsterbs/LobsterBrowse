/* #214: shared empty state. One place says "there is nothing here"
   with a shape, a short heading, one line of help and an optional
   concrete next step. role="status" announces the same information
   the old one-line strings carried. The decorative m3e-shape
   (user request 2026-11-12) replaces the icon; the icon prop stays in
   the interface so existing call sites keep compiling. */
import "@m3e/web/shape";

export default function EmptyState(props: {
  icon: string;
  headline: string;
  help?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="lb-empty-state" role="status">
      <m3e-shape name="ghost-ish" {...{ class: "lb-empty-shape" }} aria-hidden={true} />
      <div className="lb-empty-headline">{props.headline}</div>
      {props.help ? <div className="lb-empty-help">{props.help}</div> : null}
      {props.action ? (
        <m3e-button variant="tonal" onClick={props.action.onClick}>
          {props.action.label}
        </m3e-button>
      ) : null}
    </div>
  );
}
