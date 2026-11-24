/* Regression check for the COI arm (cross-origin isolation).

   The arm has two halves and one wire:
   - server: ZL_CROSS_ORIGIN_ISOLATION opts in; with_corp then stamps
     COOP: same-origin + COEP: credentialless on every served
     response, and /build announces it as "coi".
   - App.tsx: the /build coi field lands in a ref and rides BOTH
     zl:config pushes (app worker + content-origin parity), arming
     the engine's worker-side COEP stamp (Zeolite coi:/corp seams).

   Run from the repo root:

     node --experimental-strip-types tests/coi-announce/check.mjs */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const srv = readFileSync(new URL("../../server/bin/server/src/main.rs", import.meta.url), "utf8");
const app = readFileSync(new URL("../../ui/src/App.tsx", import.meta.url), "utf8");

/* Server: the env opt-in parses only affirmative values. */
assert.ok(srv.includes('fn coi_from(raw: &str) -> bool {'));
assert.ok(srv.includes('fn coi_isolated() -> bool {'));
assert.ok(srv.includes('ZL_CROSS_ORIGIN_ISOLATION'));

/* Server: the isolation pair is exact (COOP severs cross-origin
   opener access; credentialless keeps no-cors subresources
   loading without a CORP audit). */
assert.ok(
  srv.includes('"cross-origin-opener-policy",\n        HeaderValue::from_static("same-origin")'),
);
assert.ok(
  srv.includes('"cross-origin-embedder-policy",\n        HeaderValue::from_static("credentialless")'),
);

/* Server: the stamps ride the CORP layer only when armed - an
   unarmed deployment must stay byte-identical in behavior. */
assert.ok(srv.includes("if coi_isolated() {\n        coi_headers(res.headers_mut());\n    }"));

/* Server: /build announces the arm right after the query-routes
   field, and the build body carries the live value. */
assert.ok(srv.includes('\\"zlQueryRoutes\\":{},\\"coi\\":{},'));
assert.ok(srv.includes("let coi = coi_isolated();"));
assert.ok(srv.includes("        coi,\n        lb_access,"));

/* App: the arm lands in a ref (false until the deployment
   announces it) and rides both config pushes. */
assert.ok(app.includes("const coiRef = useRef(false);"));
assert.ok(app.includes("coiRef.current = b && b.coi === true;"));
assert.equal(app.split("coi: coiRef.current,").length - 1, 2, "both zl:config pushes carry coi");

/* Engine contract (source of truth lives in the Zeolite repo; this
   pins the consumer side so a silent App-side removal fails). */
assert.ok(app.includes("coi: coiRef.current,"));

console.log("coi-announce: all assertions passed");
