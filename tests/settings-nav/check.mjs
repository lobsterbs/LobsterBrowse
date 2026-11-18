/* Settings wide-layout + Android sub-card navigation regression check.

   Runs in CI with node --experimental-strip-types. Exit 1 on fail.

   Report context: the whole Settings page sat inside the shared
   .lb-view-content 720px cap, so on a wide screen the two-column page
   rendered as a small centered card ignoring most of the viewport; the
   side categories were plain pills. The check pins: the settings-only
   wide column, the 300px nav grid track, and every category being an
   Android-style sub-card with the icon inside an M3E corner-large
   tile (measurement-token padding), then the name and supporting
   line. */
import { readFileSync } from "node:fs";

const ui = new URL("../../ui/", import.meta.url);
const page = readFileSync(new URL("src/pages/Settings.tsx", ui), "utf8");
const theme = readFileSync(new URL("src/theme.css", ui), "utf8");

let fails = 0;
const ok = (name, cond) => {
  if (!cond) {
    console.error("FAIL: " + name);
    fails++;
  } else {
    console.log("ok - " + name);
  }
};

/* The settings view opts out of the narrow shared column. */
ok("section carries the lb-settings override", page.includes('className="lb-view-content lb-settings"'));
ok("theme defines the wide settings column", theme.includes(".lb-view-content.lb-settings { max-width: 1360px; }"));
ok("nav grid track widened to 300px", theme.includes("grid-template-columns: 300px minmax(0, 1fr);"));

/* Each category is an Android-style sub-card. */
ok("nav is bare cards, not a pane", theme.includes(".lb-set-nav { position: sticky; top: var(--md-sys-measurement-space100); display: flex; flex-direction: column; gap: var(--md-sys-measurement-space50); }"));
const item = theme.indexOf(".lb-set-nav-item {");
ok("nav item rule exists", item !== -1);
const itemRule = theme.slice(item, theme.indexOf("}", item));
ok("nav item real padding (12dp/16dp tokens)", itemRule.includes("padding: var(--md-sys-measurement-space150) var(--md-sys-measurement-space200);"));
ok("nav item is a rounded glass card", itemRule.includes("border-radius: 20px;") && itemRule.includes("background: var(--lb-glass-tint);"));
ok("nav item keeps the frost", itemRule.includes("backdrop-filter: blur(24px) saturate(1.4);"));

/* The icon shape inside the card, then the text column. */
const ico = theme.indexOf(".lb-set-nav-ico {");
ok("icon tile rule exists", ico !== -1);
const tile = theme.slice(ico, ico + 400);
ok("icon tile uses the M3E corner-large shape token", tile.includes("border-radius: var(--md-sys-shape-corner-large, 16px);"));
ok("icon tile colors on tokens", tile.includes("background: var(--md-sys-color-primary-container);") && tile.includes("color: var(--md-sys-color-on-primary-container);"));
const txt = theme.indexOf(".lb-set-nav-txt {");
ok("nav text column rule exists", txt !== -1);
ok("nav title uses the typescale tokens", theme.includes(".lb-set-nav-title { font-size: var(--md-sys-typescale-body-large-font-size, 16px);"));
ok("nav sub line exists", theme.includes(".lb-set-nav-sub {"));

/* The markup wires the tile, the name and the supporting line. */
ok("markup: icon inside the shape", page.includes('<span className="lb-set-nav-ico" aria-hidden={true}>'));
ok("markup: icon tile wraps m3e-icon", page.indexOf('<span className="lb-set-nav-ico"') !== -1 && page.indexOf('<span className="lb-set-nav-ico"') < page.indexOf('<m3e-icon name={SECTION_META[id].icon} />') && page.indexOf('<m3e-icon name={SECTION_META[id].icon} />') < page.indexOf('<span className="lb-set-nav-txt">'));
ok("markup: title and sub inside the text column", page.includes('<span className="lb-set-nav-title">{SECTION_TITLES[id]}</span>') && page.includes('<span className="lb-set-nav-sub">{SECTION_META[id].sub}</span>'));

/* Active accent and narrow screens. */
ok("active card keeps the app accent", theme.includes(".lb-set-nav-item.active { background: var(--md-sys-color-secondary-container);"));
ok("active card inverts its icon tile", theme.includes(".lb-set-nav-item.active .lb-set-nav-ico {"));
ok("narrow screens collapse the cards and drop the sub line", theme.indexOf('@media (max-width: 720px)') !== -1 && theme.includes(".lb-set-nav-sub { display: none; }"));

const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
ok("CI runs the settings nav check", ci.includes("tests/settings-nav/check.mjs"));

console.log(fails === 0 ? "settings-nav: all checks passed" : "settings-nav: " + fails + " check(s) failed");
process.exit(fails ? 1 : 0);
