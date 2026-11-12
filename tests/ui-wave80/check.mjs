/* Wave-80 type and shape regression checks (user request 2026-11-12):
   the Google Sans Flex expressive token layer (full-axis font import,
   LB weight ramp, display recipes, both typescale tiers, no hardcoded
   weights outside the ramp) and the decorative m3e-shape empty state.
   Plain fs checks; no app imports, so it runs anywhere node runs. */
import { readFileSync } from "node:fs";

const ui = new URL("../../ui/", import.meta.url);
const read = (p) => readFileSync(new URL(p, ui), "utf8");
let failures = 0;
const ok = (name, cond) => {
  if (cond) console.log("PASS " + name);
  else {
    failures++;
    console.error("FAIL " + name);
  }
};

/* Font loading: the full variable-axis set, not the standard subset. */
const mainTs = read("src/main.tsx");
ok("type: full axis font import present", mainTs.includes("google-sans-flex/full.css"));
ok("type: standard subset import gone", !mainTs.includes("google-sans-flex/standard.css"));

/* Token layer: the LB weight ramp, the display recipes and both
   typescale tiers. */
const theme = read("src/theme.css");
for (const tok of ["--lb-wght-plain", "--lb-wght-medium", "--lb-wght-strong", "--lb-wght-emph", "--lb-wght-display", "--lb-fvs-display", "--lb-fvs-display-round"]) {
  ok("type: token " + tok + " defined", theme.includes(tok + ":"));
}
ok("type: baseline typescale defined", theme.includes("--md-sys-typescale-display-large-font-weight: 400"));
ok("type: emphasized typescale defined", theme.includes("--md-sys-typescale-emphasized-label-large-font-weight: 700"));
const hard = [...theme.matchAll(/font-variation-settings:[^;]*"wght"\s+\d/g)];
ok("type: no hardcoded weight outside the token ramp", hard.length === 0);

/* Shape: the shared empty state renders a decorative m3e-shape. */
const empty = read("src/components/ui/EmptyState.tsx");
ok("shape: empty state shape renders", empty.includes("<m3e-shape"));
ok("shape: empty state shape is decorative", empty.includes("aria-hidden={true}"));
ok("shape: reduced motion freezes morphs", /--m3e-shape-transition:\s*none/.test(theme));

if (failures > 0) {
  console.error(failures + " check(s) failed");
  process.exit(1);
}
console.log("ui-wave80: all checks passed");
