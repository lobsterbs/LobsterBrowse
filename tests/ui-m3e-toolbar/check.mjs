/* Wave 121 regression: the @m3e/web 2.13.6 sweep changed the
   m3e-toolbar contract twice and both changes hit the LB browse
   toolbar hard.
   1. --m3e-toolbar-rounded-padding (the 2.8.2 pin, 4px) was
      renamed into four per-side -space tokens defaulting to 8px:
      with the dead pin the dock pill grew 56px -> 64px and every
      toolbar button shifted up 8px.
   2. The 2.13.6 toolbar styles its slotted standard icon buttons
      with a surfaceContainer container fill
      (--m3e-toolbar-standard-button-container-color), which LB's
      frost pill read as "every button permanently hovered".
   Both fixes are token pins in ui/src/theme.css. This gate pins
   them so no future m3e bump silently restores the taller,
   filled-in toolbar. */
import { readFileSync } from "node:fs";

const ui = new URL("../../ui/", import.meta.url);
let fails = 0;
function ok(cond, label) {
  if (cond) console.log("OK " + label);
  else { console.error("FAIL " + label); fails++; }
}

const css = readFileSync(new URL("src/theme.css", ui), "utf8");

ok(css.includes("--m3e-toolbar-rounded-top-space: 4px;")
   && css.includes("--m3e-toolbar-rounded-bottom-space: 4px;")
   && css.includes("--m3e-toolbar-rounded-leading-space: 4px;")
   && css.includes("--m3e-toolbar-rounded-trailing-space: 4px;"),
   "theme.css pins all four 2.13.6 toolbar rounded-space tokens to 4px");
ok(!/--m3e-toolbar-rounded-padding[ ]*:/m.test(css),
   "the dead 2.8.2 --m3e-toolbar-rounded-padding pin is gone");
const btnBlock = css.slice(css.indexOf(".lb-toolbar m3e-icon-button"),
                            css.indexOf(".lb-toolbar.editing"));
ok(btnBlock.includes("--m3e-standard-icon-button-container-color: transparent;")
   && btnBlock.includes("--m3e-standard-icon-button-unselected-container-color: transparent;")
   && btnBlock.includes("--m3e-standard-icon-button-selected-container-color: transparent;"),
   "toolbar icon buttons pin standard container tokens transparent (no hover-look fill)");

process.exit(fails ? 1 : 0);
