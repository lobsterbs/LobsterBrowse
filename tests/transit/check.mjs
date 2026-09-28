/* Tier-0 check: spawns the deterministic fixture and asserts every
   endpoint over plain HTTP. With LB_ORIGIN set (a locally running
   lobster-server or a deployed beta origin) it additionally asserts:
   - /zl/<b64url> answers with the honest "no worker controls this
     page" notice (the beta route, server side);
   - /r/<b64url> still proxies the fixture end to end (the stable
     engine must keep working on the beta branch).
   This proves fixture + route behavior. It can NOT prove the
   SW -> NativeTransit -> Wisp chain: no browser runs in CI. The
   browser-level run is a separate, recorded step (see
   docs/BETA-ZEOLITE-NATIVETRANSIT.md). Exit 1 on any failure. */

import { startFixture, largeBytes, streamBytes, LARGE_SIZE } from "./fixture.mjs";

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fails.push(name + (detail ? " - " + detail : ""));
}
const b64u = (s) => Buffer.from(s, "utf8").toString("base64url");

const fx = await startFixture(0);
try {
  const base = fx.origin;

  let r = await fetch(base + "/");
  ok("html status 200", r.status === 200, "got " + r.status);
  ok("html content-type", (r.headers.get("content-type") || "").includes("text/html"));
  const html = await r.text();
  ok("html content", html.includes("fixture page") && html.includes("<script src=\"/app.js\">"), html.slice(0, 80));

  r = await fetch(base + "/style.css");
  ok("css status 200", r.status === 200);
  ok("css content has url()", (await r.text()).includes("url(/l.png)"));

  r = await fetch(base + "/app.js");
  ok("js status 200", r.status === 200);
  ok("js content-type", (r.headers.get("content-type") || "").includes("javascript"));
  ok("js content", (await r.text()).includes("fetch("));

  r = await fetch(base + "/data.json");
  ok("json status 200", r.status === 200);
  const j = await r.json();
  ok("json parse ok:true", j.ok === true && j.n === 42);

  r = await fetch(base + "/redirect", { redirect: "manual" });
  ok("redirect 302", r.status === 302, "got " + r.status);
  ok("redirect location /", r.headers.get("location") === "/");

  r = await fetch(base + "/echo", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "hello=world",
  });
  const echo = await r.json();
  ok("post method POST", echo.method === "POST", echo.method);
  ok("post body echoed", echo.body === "hello=world", echo.body);

  r = await fetch(base + "/stream");
  const streamed = Buffer.from(await r.arrayBuffer());
  ok("stream length", streamed.length === streamBytes.length, "got " + streamed.length);
  ok("stream bytes exact", streamed.equals(streamBytes));

  r = await fetch(base + "/large");
  const big = Buffer.from(await r.arrayBuffer());
  ok("large length", big.length === LARGE_SIZE, "got " + big.length);
  ok("large bytes exact", big.equals(largeBytes));

  r = await fetch(base + "/large", { headers: { range: "bytes=100-199" } });
  ok("range 206", r.status === 206, "got " + r.status);
  ok("range content-range", (r.headers.get("content-range") || "") === "bytes 100-199/" + LARGE_SIZE, r.headers.get("content-range"));
  const slice = Buffer.from(await r.arrayBuffer());
  ok("range bytes exact", slice.length === 100 && slice.equals(largeBytes.subarray(100, 200)), "len " + slice.length);

  r = await fetch(base + "/set-cookie");
  const sc = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [r.headers.get("set-cookie")];
  ok("set-cookie two cookies", sc.length === 2, JSON.stringify(sc));

  r = await fetch(base + "/cookie", { headers: { cookie: "zlprobe=a; zlprobe2=b" } });
  ok("cookie echo", (await r.text()) === "zlprobe=a; zlprobe2=b");

  r = await fetch(base + "/sse");
  ok("sse content-type", (r.headers.get("content-type") || "").includes("text/event-stream"));
  const sse = await r.text();
  ok("sse 3 events", (sse.match(/data: tick/g) || []).length === 3, JSON.stringify(sse));

  const lb = process.env.LB_ORIGIN;
  if (lb) {
    const rz = await fetch(lb + "/zl/" + b64u(base + "/data.json"));
    const zt = await rz.text();
    ok("zl honest notice status 200", rz.status === 200, "got " + rz.status);
    ok("zl honest notice text", zt.includes("Zeolite runs in its service worker"), zt.slice(0, 120));
    ok("zl does not proxy server-side", zt.indexOf("\"ok\":true") === -1, "body contains fixture json!");

    const rj = await fetch(lb + "/r/" + b64u(base + "/data.json"));
    ok("r json status 200", rj.status === 200, "got " + rj.status);
    const rjd = await rj.json();
    ok("r json passthrough", rjd.ok === true && rjd.n === 42);

    const rh = await fetch(lb + "/r/" + b64u(base + "/"));
    const rht = await rh.text();
    ok("r html status 200", rh.status === 200);
    ok("r html rewritten to /r/", rht.includes("/r/"), "no /r/ prefix in served html");

    const rl = await fetch(lb + "/r/" + b64u(base + "/large"), { headers: { range: "bytes=0-99" } });
    ok("r large range status", rl.status === 206 || rl.status === 200, "got " + rl.status);
    const rlb = Buffer.from(await rl.arrayBuffer());
    ok("r large bytes start", rlb.length >= 100 && rlb.subarray(0, 100).equals(largeBytes.subarray(0, 100)), "len " + rlb.length);
  }
} finally {
  await fx.close();
}

console.log("tier-0: " + pass + " passed, " + fails.length + " failed" + (process.env.LB_ORIGIN ? " (LB_ORIGIN checks ran)" : " (fixture-only; set LB_ORIGIN for server checks)"));
for (const f of fails) console.log("  FAIL " + f);
if (fails.length) process.exit(1);
