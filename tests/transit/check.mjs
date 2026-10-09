/* Tier-0 check: spawns the deterministic fixture and asserts every
   endpoint over plain HTTP. With LB_ORIGIN set (a locally running
   lobster-server or a deployed beta origin) it additionally asserts:
   - /zl/<b64url> answers with the honest "no worker controls this
     page" notice (the engine route, server side);
   - the legacy /r/ and /lj/ prefixes answer the honest gone-notice
     (502 engine_error_page), never a redirect or the SPA fallback.
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

/* FIXTURE_ORIGIN: verify an already-deployed fixture (for example
   https://lobsterbrowse-fixture.onrender.com) instead of spawning a
   local one; pair it with LB_ORIGIN to gate a deployed beta
   end to end. */
const extFx = (process.env.FIXTURE_ORIGIN || "").replace(/\/+$/, "");
const fx = extFx ? null : await startFixture(0);
try {
  const base = extFx || fx.origin;

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

  /* Raw-socket WS probe: local spawn only (needs the fixture port). */
  if (!extFx) {
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

  /* Tier-7: redirect chains, 303/307 method replay, conditional GET,
     204, MIME-typed binaries, cookie Path scoping, SPA page shape. */
  r = await fetch(base + "/redir-chain/a", { redirect: "manual" });
  ok("chain a 302", r.status === 302, "got " + r.status);
  ok("chain a relative location", r.headers.get("location") === "/redir-chain/b", String(r.headers.get("location")));
  {
    const sc2 = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [r.headers.get("set-cookie")];
    ok("chain a hop cookie", sc2.length === 1 && sc2[0].startsWith("hopprobe=a"), JSON.stringify(sc2));
  }
  r = await fetch(base + "/redir-chain/a");
  ok("chain followed status 200", r.status === 200, "got " + r.status);
  const chain = await r.json();
  ok("chain done", chain.chain === "done", JSON.stringify(chain));

  r = await fetch(base + "/redir-303", { method: "POST", redirect: "manual", body: "x=2", headers: { "content-type": "application/x-www-form-urlencoded" } });
  ok("303 manual status", r.status === 303, "got " + r.status);
  ok("303 location /echo", r.headers.get("location") === "/echo", String(r.headers.get("location")));
  r = await fetch(base + "/redir-303", { method: "POST", body: "x=2", headers: { "content-type": "application/x-www-form-urlencoded" } });
  const e303 = await r.json();
  ok("303 POST becomes GET", e303.method === "GET", e303.method);
  ok("303 body dropped", e303.body === "", JSON.stringify(e303.body));

  r = await fetch(base + "/redir-307", { method: "POST", redirect: "manual", body: "x=2", headers: { "content-type": "application/x-www-form-urlencoded" } });
  ok("307 manual status", r.status === 307, "got " + r.status);
  r = await fetch(base + "/redir-307", { method: "POST", body: "x=2", headers: { "content-type": "application/x-www-form-urlencoded" } });
  const e307 = await r.json();
  ok("307 replays POST", e307.method === "POST", e307.method);
  ok("307 preserves body", e307.body === "x=2", e307.body);

  r = await fetch(base + "/etag");
  ok("etag 200", r.status === 200, "got " + r.status);
  ok("etag header", r.headers.get("etag") === "\"fixed-etag\"", String(r.headers.get("etag")));
  ok("etag body", (await r.text()) === "etag body");
  r = await fetch(base + "/etag", { headers: { "if-none-match": "\"fixed-etag\"" } });
  ok("etag conditional 304", r.status === 304, "got " + r.status);

  r = await fetch(base + "/nocontent");
  ok("204 status", r.status === 204, "got " + r.status);
  ok("204 empty body", (await r.text()) === "");

  r = await fetch(base + "/font.woff2");
  ok("font content-type", (r.headers.get("content-type") || "").includes("font/woff2"), String(r.headers.get("content-type")));
  {
    const fb = Buffer.from(await r.arrayBuffer());
    ok("font magic wOF2", fb.length === 64 && fb.subarray(0, 4).toString("latin1") === "wOF2", "len " + fb.length);
  }

  r = await fetch(base + "/media.mp4");
  ok("media content-type", (r.headers.get("content-type") || "").includes("video/mp4"), String(r.headers.get("content-type")));
  {
    const mb = Buffer.from(await r.arrayBuffer());
    ok("media ftyp box", mb.length === 32 && mb.subarray(4, 8).toString("latin1") === "ftyp", "len " + mb.length);
  }

  r = await fetch(base + "/icon.svg");
  ok("svg content-type", (r.headers.get("content-type") || "").includes("image/svg+xml"), String(r.headers.get("content-type")));
  ok("svg use href", (await r.text()).includes("<use href=\"sprite.svg#sym\""));

  r = await fetch(base + "/manifest.webmanifest");
  ok("manifest content-type", (r.headers.get("content-type") || "").includes("application/manifest+json"), String(r.headers.get("content-type")));
  ok("manifest json name", (await r.json()).name === "fixture");

  r = await fetch(base + "/cookie-scope");
  {
    const scs = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [r.headers.get("set-cookie")];
    ok("cookie-scope Path=/scoped", scs.length === 1 && scs[0].startsWith("pathprobe=p; Path=/scoped"), JSON.stringify(scs));
  }
  r = await fetch(base + "/scoped/cookie", { headers: { cookie: "pathprobe=p" } });
  ok("scoped cookie echo", (await r.text()) === "pathprobe=p");

  r = await fetch(base + "/spa.html");
  ok("spa 200 html", r.status === 200 && (r.headers.get("content-type") || "").includes("text/html"), r.status + " " + r.headers.get("content-type"));
  const spa = await r.text();
  ok("spa deterministic pieces",
    spa.includes("history.pushState") && spa.includes("history.replaceState") &&
    spa.includes("popstate") && spa.includes("window.open") &&
    spa.includes("href=\"sub/page\"") && spa.includes("href=\"https://example.com/abs\""),
    spa.slice(0, 80));

  /* Tier-8 (Vanadium): navigation surfaces + authentication flow. */
  r = await fetch(base + "/nav.html");
  ok("nav 200 html", r.status === 200 && (r.headers.get("content-type") || "").includes("text/html"), r.status + " " + r.headers.get("content-type"));
  const nav = await r.text();
  ok("nav carries surfaces",
    nav.includes("<iframe src=\"/frame.html\"") &&
    nav.includes("<script type=\"module\" src=\"/mod.mjs\"") &&
    nav.includes("new XMLHttpRequest") && nav.includes("import(\"/dyn.mjs\")") &&
    nav.includes("href=\"rel/page\"") && nav.includes("href=\"/abs/page\"") && nav.includes("href=\"https://example.com/x\""),
    nav.slice(0, 80));
  r = await fetch(base + "/frame.html");
  ok("frame 200 html", r.status === 200 && (await r.text()).includes("frame page"));
  r = await fetch(base + "/mod.mjs");
  ok("mod.mjs 200 js", r.status === 200 && (r.headers.get("content-type") || "").includes("javascript") && (await r.text()).includes("export const ok"));
  r = await fetch(base + "/dyn.mjs");
  ok("dyn.mjs 200 js", r.status === 200 && (await r.text()).includes("dyn-ok"));

  r = await fetch(base + "/auth/protected", { redirect: "manual" });
  ok("auth redirect 302", r.status === 302, "got " + r.status);
  ok("auth redirect to login", r.headers.get("location") === "/auth/login", String(r.headers.get("location")));
  r = await fetch(base + "/auth/login");
  {
    const scl = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [r.headers.get("set-cookie")];
    ok("login sets sid", scl.length === 1 && scl[0].startsWith("sid=auth"), JSON.stringify(scl));
  }
  ok("login page body", (await r.text()).includes("login page"));
  r = await fetch(base + "/auth/protected", { headers: { cookie: "sid=auth" } });
  ok("auth cookie accepted", r.status === 200 && (await r.json()).auth === "ok", "got " + r.status);
  r = await fetch(base + "/auth/protected", { headers: { cookie: "sid=wrong" }, redirect: "manual" });
  ok("wrong cookie still redirected", r.status === 302, "got " + r.status);

  /* Tier-9 (Vanadium): import map surfaces. */
  r = await fetch(base + "/importmap.html");
  ok("importmap 200 html", r.status === 200 && (r.headers.get("content-type") || "").includes("text/html"), r.status + " " + r.headers.get("content-type"));
  const im = await r.text();
  ok("importmap carries map",
    im.includes("\"im-bare\":\"/im-bare.mjs\"") &&
    im.includes("\"/im-path.mjs\":\"/im-alt.mjs\"") &&
    im.includes("\"im-arr\":[\"/im-arr1.mjs\",\"data:text/javascript,export const ok = 1\"]") &&
    im.includes("from \"im-bare\""),
    im.slice(0, 100));
  r = await fetch(base + "/im-bare.mjs");
  ok("im-bare.mjs 200 js", r.status === 200 && (await r.text()).includes("im-bare-ok"));
  r = await fetch(base + "/im-alt.mjs");
  ok("im-alt.mjs 200 js", r.status === 200 && (await r.text()).includes("im-alt-ok"));
  r = await fetch(base + "/im-arr1.mjs");
  ok("im-arr1.mjs 200 js", r.status === 200 && (await r.text()).includes("im-arr1-ok"));

  /* Tier-10 (Vanadium): CSS url() shapes, srcset, page-query echo. */
  r = await fetch(base + "/css-probes.css");
  ok("css-probes 200 css", r.status === 200 && (r.headers.get("content-type") || "").includes("text/css"), r.status + " " + r.headers.get("content-type"));
  const cssp = await r.text();
  ok("css-probes carries shapes",
    cssp.includes("@import url(\"/style.css\");") &&
    cssp.includes("url(/l.png);") &&
    cssp.includes("url('/l.png?v=2');") &&
    cssp.includes("url(\"data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7\");"),
    cssp.slice(0, 80));
  ok("nav carries srcset", nav.includes("srcset=\"/l.png 1x, /icon.svg 2x\""), nav.slice(0, 80));
  r = await fetch(base + "/query?say=hi%20there&flag");
  const qd = await r.json();
  ok("query echoes raw target", qd.method === "GET" && qd.url === "/query?say=hi%20there&flag", JSON.stringify(qd));

  const lb = process.env.LB_ORIGIN;
  if (lb) {
    const rz = await fetch(lb + "/zl/" + b64u(base + "/data.json"));
    const zt = await rz.text();
    /* The route reuses engine_error_page (the honest load-failure
       card), which answers 502 Bad Gateway - it is a cold-start
       notice, not a 503. */
    ok("zl honest notice status 502", rz.status === 502, "got " + rz.status);
    ok("zl honest notice text", zt.includes("Zeolite runs in its service worker"), zt.slice(0, 120));
    ok("zl does not proxy server-side", zt.indexOf("\"ok\":true") === -1, "body contains fixture json!");

    /* The engine dist resolves rewriter_wasm_bg.wasm root-absolute,
       like /bootstrap.js: the origin-root alias must serve the
       vendored wasm, or the rewriter init 404s silently. */
    const rw = await fetch(lb + "/rewriter_wasm_bg.wasm");
    ok("wasm alias status 200", rw.status === 200, "got " + rw.status);
    ok("wasm alias content type", (rw.headers.get("content-type") || "").includes("application/wasm"), String(rw.headers.get("content-type")));
    const rwb = Buffer.from(await rw.arrayBuffer());
    ok("wasm alias magic", rwb.subarray(0, 4).toString("latin1") === "\0asm", "len " + rwb.length);

    /* Legacy prefixes are unowned (#67): /r/ and /lj/ must break
       honestly with the engine_error_page gone-notice (502), never a
       302 rescue and never the SPA fallback (index.html 200). */
    const lt = base + "/data.json?say=hi%20there&flag";
    for (const p of ["/r/", "/lj/"]) {
      const res = await fetch(lb + p + b64u(lt), { redirect: "manual" });
      ok(p + " gone-notice 502", res.status === 502, "got " + res.status);
      const body = await res.text();
      ok(p + " gone-notice text", body.includes("legacy engine route prefix is gone"), body.slice(0, 120));
    }
  }
} finally {
  /* One-shot CI process: awaiting server.close() can leave this
     module's top-level await pending (keep-alive / upgraded sockets),
     which node ends with silent exit code 13. Close is best-effort;
     the explicit exit below is authoritative. */
  console.error("tier-0: body done" + (fx ? ", closing fixture" : ""));
  if (fx) fx.close();
}

console.log("tier-0: " + pass + " passed, " + fails.length + " failed" + (process.env.LB_ORIGIN ? " (LB_ORIGIN checks ran)" : " (fixture-only; set LB_ORIGIN for server checks)"));
for (const f of fails) console.log("  FAIL " + f);
process.exit(fails.length ? 1 : 0);
