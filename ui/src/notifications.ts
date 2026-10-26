/* M3E action snackbar for recoverable UI failures. Operational errors
   live here rather than under whichever settings control failed. */
import { pushLog } from "./store";
import { sanitizeText } from "./sanitize";

export function notifyFailure(message: string, retry?: () => void): void {
  const safe = sanitizeText(message).slice(0, 240);
  pushLog("error", safe);
  if (typeof M3eSnackbar === "undefined" || !M3eSnackbar) return;
  if (retry) {
    M3eSnackbar.open(safe, "Try again", {
      actionCallback: retry,
      duration: 9000,
    });
  } else {
    M3eSnackbar.open(safe, { duration: 6000 });
  }
}
