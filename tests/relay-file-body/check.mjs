/* Relay File-body envelope gate (Zeolite #633/#704, fixed
   2026-11-21): the engine's hop chain stages every page POST body to
   the OPFS replay spool before the transport sees it, so the File
   that crosses the relay port IS the common case on relay-only
   embedders - not an edge. An embedder whose zl:fetchRelay handler
   serialized only string/ArrayBuffer bodies sent every page POST
   upstream bodyless: Google's accounts batchexecute answered
   xsrf-400, Startpage's /sp/apb answered nginx 400. This check pins
   the envelope builder's File arm, its 23 MiB route budget, and the
   pre-dispatch honesty of the over-budget refusal. Exit 1 on any
   failure. */
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
let fails = 0;
const ok = (cond, label) => {
  if (cond) console.log("ok - " + label);
  else { fails++; console.log("FAIL - " + label); }
};

const z = read("../../ui/src/zeolite.ts");
ok(z.includes("RELAY_FILE_MAX_BYTES = 23 * 1024 * 1024"),
  "the file-body route budget is 23 MiB (32 MiB envelope minus 4/3 base64 inflation)");
ok(z.includes("class RelayFileTooBigError extends Error"),
  "the over-budget refusal has its own error class");
ok(z.includes("m.body instanceof Blob"),
  "the envelope builder has a Blob/File arm");
ok(z.includes("await relayFileBody(m.body)"),
  "the File arm reads the spooled body before the envelope is built");
ok(z.includes(
  "...(typeof body === " + String.fromCharCode(34) + "string" + String.fromCharCode(34) + " && typeof m.body !== " + String.fromCharCode(34) + "string" + String.fromCharCode(34) + " ? { body_b64: body } : {})"),
  "non-string bodies ride the envelope as body_b64");
ok(z.includes(
  "e instanceof RelayFileTooBigError ? " + String.fromCharCode(34) + "definitely-not-delivered" + String.fromCharCode(34) + " : undefined"),
  "the over-budget refusal is pre-dispatch honest (engine may replay on its secondary transport)");

const ciwf = read("../../.github/workflows/ci.yml");
ok(ciwf.includes("relay-file-body"),
  "ci.yml runs the relay file-body check");

console.log(fails === 0 ? "ALL OK" : fails + " FAILURES");
process.exit(fails ? 1 : 0);
