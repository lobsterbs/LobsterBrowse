/* Install prompt for a downloaded .xpi add-on package. The dialog opens
   the moment the user clicks the download link - a real popup, not a
   toolbar button: a busy state streams live progress while the package
   transfers, the ready state asks the install question, and a failed
   transfer turns the same dialog into an honest error.

   Built on m3e-dialog, the same pattern Settings uses for its delete
   confirmation: the dialog owns the scrim, focus trap, Escape and focus
   return. Each action returns a value through m3e-dialog-action; any
   other dismissal (Escape, scrim, Cancel, Close) closes with an empty
   value and is treated as a cancel - which also stops the transfer
   while the busy state is up. */
import { useEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";
import { fmtBytes } from "./browserShared";

type DialogEl = HTMLElement & { show: () => Promise<void>; returnValue: string };

export default function XpiPrompt(props: {
  name: string;
  got: number;
  size: number;
  bytes?: Uint8Array;
  error?: string;
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

  /* #212: the wavy progress follows the reduced-motion preference. */
  const flatProgress = useReducedMotion() === true;
  const known = props.size > 0;

  return (
    <m3e-dialog {...{ ref: dialogRef }}>
      {props.error ? (
        <>
          <span slot="header">Download failed</span>
          <p className="lb-site-row">{props.name}</p>
          <p className="lb-site-note">{props.error}</p>
          <div slot="actions">
            <m3e-button autofocus>
              <m3e-dialog-action return-value="cancel">Close</m3e-dialog-action>
            </m3e-button>
          </div>
        </>
      ) : props.bytes ? (
        <>
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
        </>
      ) : (
        <>
          <span slot="header">Downloading add-on</span>
          <p className="lb-site-row">{props.name}</p>
          <div className="lb-xpi-progress">
            <m3e-linear-progress-indicator
              aria-label={"Downloading " + props.name}
              variant={flatProgress ? "flat" : "wavy"}
              value={known ? String(Math.round((props.got / props.size) * 100)) : undefined}
              max="100"
              mode={known ? undefined : "indeterminate"}
            />
          </div>
          <p className="lb-site-note">
            {known ? fmtBytes(props.got) + " of " + fmtBytes(props.size) : fmtBytes(props.got) + " downloaded"}
          </p>
          <div slot="actions">
            <m3e-button>
              <m3e-dialog-action return-value="cancel">Cancel</m3e-dialog-action>
            </m3e-button>
          </div>
        </>
      )}
    </m3e-dialog>
  );
}
