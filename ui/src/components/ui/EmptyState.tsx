/* #214: shared empty state. One place says "there is nothing here"
   with an icon, a short heading, one line of help and an optional
   concrete next step. role="status" announces the same information
   the old one-line strings carried; only existing M3E components
   (m3e-icon, m3e-button, both registered by main.tsx), no new
   dependency. */
export default function EmptyState(props: {
  icon: string;
  headline: string;
  help?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="lb-empty-state" role="status">
      <m3e-icon name={props.icon} aria-hidden={true} />
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
