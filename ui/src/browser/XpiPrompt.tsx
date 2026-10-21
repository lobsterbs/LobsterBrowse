/* Install prompt for a downloaded .xpi add-on package. Presentational:
   the bytes and the install/save actions stay in pages/Browser.tsx.

   Built on m3e-dialog, the same pattern Settings uses for its delete
   confirmation: the dialog owns the scrim, focus trap, Escape and focus
   return. Each action returns a value through m3e-dialog-action; any
   other dismissal (Escape, scrim, Cancel) closes with an empty value
   and is treated as a cancel. */
import { useEffect, useRef } from "react";
import { fmtBytes } from "./browserShared";

type DialogEl = HTMLElement & { show: () => Promise<void>; returnValue: string };

export default function XpiPrompt(props: {
  name: string;
  bytes: Uint8Array;
  onInstall: () => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<DialogEl | null>(null);
  /* The closed listener is attached once, so it reads the latest
     callbacks through this ref. */
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const onClosed = () => {
      const v = el.returnValue;
      if (v === "install") latest.current.onInstall();
      else if (v === "save") latest.current.onSave();
      else latest.current.onCancel();
    };
    el.addEventListener("closed", onClosed);
    void el.show();
    return () => el.removeEventListener("closed", onClosed);
  }, []);

  return (
    <m3e-dialog {...{ ref: dialogRef }}>
      <span slot="header">Install extension?</span>
      <p className="lb-site-row">
        {props.name} ({fmtBytes(props.bytes.length)})
      </p>
      <p className="lb-site-note">
        Install this add-on into LobsterBrowse Preview? The engine validates the package before anything runs.
        You can also save the file and import it later from Settings.
      </p>
      <div slot="actions">
        <m3e-button>
          <m3e-dialog-action return-value="install">
            <m3e-icon name="extension" aria-hidden={true} /> Install
          </m3e-dialog-action>
        </m3e-button>
        <m3e-button>
          <m3e-dialog-action return-value="save">
            <m3e-icon name="download" aria-hidden={true} /> Save file
          </m3e-dialog-action>
        </m3e-button>
        <m3e-button autofocus>
          <m3e-dialog-action return-value="cancel">Cancel</m3e-dialog-action>
        </m3e-button>
      </div>
    </m3e-dialog>
  );
}
