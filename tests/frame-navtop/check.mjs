// Regression check: Zeolite #558 navigateTab frame payload contract.
import { NAVTAB_ACK_MAX, NAVTAB_HREF_MAX, parseNavTab } from "../../ui/src/frameNav.ts";

let failed = 0;
function check(name, cond) {
  if (cond) console.log("ok - " + name);
  else { failed++; console.error("FAIL - " + name); }
}

const good = parseNavTab({
  href: "https://accounts.google.com/ServiceLogin?continue=x",
  clientId: "c1",
  ack: "zltop1",
});
check(
  "accepts a well-formed request",
  good !== null &&
    good.href === "https://accounts.google.com/ServiceLogin?continue=x" &&
    good.ack === "zltop1",
);
check(
  "caps the href at the hygiene bound",
  NAVTAB_HREF_MAX === 2000 &&
    parseNavTab({ href: "https://x.example/" + "a".repeat(5000) }).href.length === 2000,
);
check("refuses javascript: scheme", parseNavTab({ href: "javascript:alert(1)" }) === null);
check("refuses data: scheme", parseNavTab({ href: "data:text/html,hi" }) === null);
check(
  "refuses a missing, non-string or empty href",
  parseNavTab({ clientId: "c" }) === null &&
    parseNavTab({ href: 42 }) === null &&
    parseNavTab({ href: "" }) === null,
);
check(
  "refuses non-object payloads",
  parseNavTab("x") === null && parseNavTab(null) === null && parseNavTab(undefined) === null,
);
check(
  "ack is optional and bounded",
  parseNavTab({ href: "https://x.example/" }).ack === null &&
    parseNavTab({ href: "https://x.example/", ack: "x".repeat(NAVTAB_ACK_MAX + 1) }).ack === null,
);
check(
  "ignores unknown extra fields",
  parseNavTab({ href: "https://x.example/", evil: "yes" }).href === "https://x.example/",
);

if (failed > 0) {
  console.error(failed + " frame-navtop check(s) failed");
  process.exit(1);
}
console.log("frame-navtop: all checks passed");
