/* Install prompt for a downloaded .xpi add-on package. Presentational:
   the bytes and the install/save actions stay in pages/Browser.tsx. */
import { fmtBytes } from "./browserShared";

export default function XpiPrompt(props: {
  name: string;
  bytes: Uint8Array;
  onInstall: () => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="lb-xpi-overlay" role="dialog" aria-label="Install extension" onClick={props.onCancel}>
      <m3e-card variant="elevated" {...{ class: "lb-xpi-card" }} onClick={(e) => e.stopPropagation()}>
        <div slot="header" className="lb-site-head">
          <span className="lb-site-ctitle">Install extension?</span>
        </div>
        <div slot="content" className="lb-site-body">
          <div className="lb-site-row">{props.name} ({fmtBytes(props.bytes.length)})</div>
          <p className="lb-site-note">
            Install this add-on into LobsterBrowse Preview? The engine validates the package before anything runs.
            You can also save the file and import it later from Settings.
          </p>
        </div>
        <div slot="actions" className="lb-site-actions">
          <m3e-button onClick={props.onInstall}>
            <m3e-icon name="extension" aria-hidden={true} /> Install
          </m3e-button>
          <m3e-button onClick={props.onSave}>
            <m3e-icon name="download" aria-hidden={true} /> Save file
          </m3e-button>
          <m3e-button onClick={props.onCancel}>Cancel</m3e-button>
        </div>
      </m3e-card>
    </div>
  );
}
