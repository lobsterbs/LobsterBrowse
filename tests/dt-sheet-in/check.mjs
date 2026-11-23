/* Gate: the DevTools bottom sheet slides up on open.
   Root cause (2026-11-23 report): the non-modal m3e-bottom-sheet host
   animates open through its own transform transition from a closed
   state, but DevTools unmounts the sheet 280 ms after close, so every
   open mounts it fresh with [open] already set - there was never a
   previous state to transition from and the sheet popped in with no
   entrance while every other sheet slid. The fix is a pure CSS
   @starting-style rule that hands the freshly mounted open sheet the
   same off-screen transform the host uses while closed; the host's
   own transition does the sliding. Reduced motion freezes it.
   Run: node --experimental-strip-type ../tests/dt-sheet-in/check.mjs */
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const theme = read("../../ui/src/theme.css");
const devtools = read("../../ui/src/pages/DevTools.tsx");
const ci = read("../../.github/workflows/ci.yml");
let fails = 0;
const ok = (c, l) => { if (c) console.log("ok - " + l); else { fails++; console.log("FAIL - " + l); } };

/* 1. The starting style: the freshly mounted open sheet starts below
   the fold on the exact transform the host uses while closed, so the
   host's own transition slides it up into place. */
ok(theme.includes("@starting-style { .lb-dt-sheet[open] { transform: translateX(-50%) translateY(100%); } }"),
   "the open sheet starts from the host's closed transform");

/* 2. The slide rides the host's own transition; no extra animation or
   JS entrance for the sheet body may shadow it. */
ok(!theme.includes(".lb-dt-sheet { animation:"), "no competing sheet animation may override the host transition");
ok(!devtools.includes("lb-dt-sheet-enter"), "no JS sheet-entrance helper exists");

/* 3. Reduced motion: the entrance freeze must cover the host
   transition itself, or the starting style still slides. */
ok(theme.includes(".lb-dt-sheet { transition: none; }"), "reduced motion freezes the host transition for the dt sheet");

/* 4. CI wiring. */
ok(ci.includes("../tests/dt-sheet-in/check.mjs"), "ci runs the dt-sheet-in gate");
process.exit(fails ? 1 : 0);
