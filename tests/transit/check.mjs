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
import net from "node:net";
import crypto from "node:crypto";

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

  r = await fetch(base + "/hdrs", { headers: { "x-lb-probe": "abc123" } });
  ok("hdrs status 200", r.status === 200);
  const hdrs = await r.json();
  ok("hdrs echoes custom header", (hdrs["x-lb-probe"] || "") === "abc123", JSON.stringify(hdrs["x-lb-probe"]));

  r = await fetch(base + "/set-cookie1");
  const sc1 = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [r.headers.get("set-cookie")];
  ok("set-cookie1 single cookie", sc1.length === 1 && sc1[0].startsWith("zlprobe1=a"), JSON.stringify(sc1));

  r = await fetch(base + "/worker.js");
  ok("worker status 200", r.status === 200);
  ok("worker content-type", (r.headers.get("content-type") || "").includes("javascript"));
  ok("worker content", (await r.text()).includes("fetch("));

  r = await fetch(base + "/module-worker.js");
  ok("module worker status 200", r.status === 200);
  ok("module worker content-type", (r.headers.get("content-type") || "").includes("javascript"));

  r = await fetch(base + "/workers.html");
  ok("workers page 200", r.status === 200);
  const wht = await r.text();
  ok("workers page probes", wht.includes("new Worker(") && wht.includes("WebSocket(") && wht.includes("worker page"));

  {
    const key = crypto.randomBytes(16).toString("base64");
    const sock = net.connect(fx.port, "127.0.0.1");
    await new Promise((resolve) => { sock.on("connect", resolve); });
    sock.write("GET /ws HTTP/1.1\r\nHost: fixture\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n");
    const reply = await new Promise((resolve) => {
      let acc = Buffer.alloc(0);
      const t = setTimeout(() => resolve(acc), 3000);
      sock.on("data", (d) => { acc = Buffer.concat([acc, d]); if (acc.indexOf("\r\n\r\n") !== -1) { clearTimeout(t); resolve(acc); } });
    });
    ok("ws handshake 101", reply.toString("utf8").startsWith("HTTP/1.1 101"), reply.toString("utf8").slice(0, 40));
    const mask = crypto.randomBytes(4);
    const msg = Buffer.from("wsprobe", "utf8");
    const frame = Buffer.alloc(2 + 4 + msg.length);
    frame[0] = 0x81;
    frame[1] = 0x80 | msg.length;
    mask.copy(frame, 2);
    for (let i = 0; i < msg.length; i++) frame[6 + i] = msg[i] ^ mask[i & 3];
    const echo = await new Promise((resolve) => {
      let acc2 = Buffer.alloc(0);
      const t = setTimeout(() => resolve(acc2), 3000);
      sock.on("data", (d) => { acc2 = Buffer.concat([acc2, d]); if (acc2.length >= 2 + msg.length) { clearTimeout(t); resolve(acc2); } });
      sock.write(frame);
    });
    ok("ws echo exact", echo.length >= 2 + msg.length && echo[0] === 0x81 && echo.subarray(2, 2 + msg.length).toString("utf8") === "wsprobe", echo.toString("hex").slice(0, 30));
    sock.destroy();
  }

  const lb = process.env.LB_ORIGIN;
  if (lb) {
    const rz = await fetch(lb + "/zl/" + b64u(base + "/data.json"));
    const zt = await rz.text();
    ok("zl honest notice status 503", rz.status === 503, "got " + rz.status);
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
