import http from "node:http";
import crypto from "node:crypto";

/* Deterministic Tier-0 fixture for the Zeolite NativeTransit beta
   (beta/zeolite-nativetransit). Every response byte is stable so
   tests/transit/check.mjs - and later a real-browser session - can
   assert exact behavior through the whole chain:
   LB -> Zeolite SW -> NativeTransit -> Wisp -> here -> and back.

   Standalone: node tests/transit/fixture.mjs  (serves on 127.0.0.1:3999; PORT/FIXTURE_HOST env override for public deploys) */

export const LARGE_SIZE = 2 * 1024 * 1024;
export const STREAM_CHUNKS = 10;
export const STREAM_CHUNK_SIZE = 1024;

const large = Buffer.alloc(LARGE_SIZE);
for (let i = 0; i < LARGE_SIZE; i++) large[i] = (i * 7 + 13) & 0xff;
export const largeBytes = large;

const streamChunks = [];
for (let c = 0; c < STREAM_CHUNKS; c++) {
  const b = Buffer.alloc(STREAM_CHUNK_SIZE);
  for (let i = 0; i < STREAM_CHUNK_SIZE; i++) b[i] = (c * 31 + i * 3 + 7) & 0xff;
  streamChunks.push(b);
}
export const streamBytes = Buffer.concat(streamChunks);

const HTML = [
  "<!doctype html><html><head><meta charset=\"utf-8\">",
  "<link rel=\"stylesheet\" href=\"/style.css\">",
  "<title>fixture</title></head><body>",
  "<h1>fixture page</h1>",
  "<a href=\"/redirect\">redirect link</a>",
  "<a href=\"/data.json\">json link</a>",
  "<script src=\"/app.js\"></script>",
  "</body></html>",
].join("");

const CSS = "body { background: #123; } .bg { background-image: url(/l.png); }";
const JS = "console.log('fixture'); fetch('/data.json').then(r => r.json());";
const JSON_BODY = "{\"ok\":true,\"n\":42}";

/* Tier-6 probes (workers, WebSocket echo, header echo, single-cookie
   jar discrimination). Deterministic like everything else here. */
const WORKER_JS = "self.onmessage = function (e) { fetch(\"/data.json\").then(function (r) { return r.text(); }).then(function (t) { postMessage({ status: \"ok\", body: t }); }).catch(function (err) { postMessage({ error: String(err) }); }); };";
const MODULE_WORKER_JS = WORKER_JS;
const WORKERS_HTML = [
  "<!doctype html><html><head><meta charset=\"utf-8\">",
  "<title>workers</title></head><body>",
  "<h1>worker page</h1>",
  "<div id=\"classic\">pending</div>",
  "<div id=\"module\">pending</div>",
  "<div id=\"wsrel\">pending</div>",
  "<div id=\"wsabs\">pending</div>",
  "<script>",
  "var set = function (id, v) { document.getElementById(id).textContent = v; };",
  "try {",
  "  var w = new Worker(\"/worker.js\");",
  "  w.onmessage = function (e) { set(\"classic\", JSON.stringify(e.data)); };",
  "  w.onerror = function (e) { set(\"classic\", \"error: \" + (e.message || \"load failed\")); };",
  "  w.postMessage(\"go\");",
  "} catch (e) { set(\"classic\", \"throw: \" + String(e)); }",
  "try {",
  "  var w2 = new Worker(\"/module-worker.js\", { type: \"module\" });",
  "  w2.onmessage = function (e) { set(\"module\", JSON.stringify(e.data)); };",
  "  w2.onerror = function (e) { set(\"module\", \"error: \" + (e.message || \"load failed\")); };",
  "  w2.postMessage(\"go\");",
  "} catch (e) { set(\"module\", \"throw: \" + String(e)); }",
  "var wsUrl = (location.protocol === \"https:\" ? \"wss://\" : \"ws://\") + location.host + \"/ws\";",
  "try {",
  "  var ws = new WebSocket(wsUrl);",
  "  ws.onopen = function () { set(\"wsrel\", \"open\"); };",
  "  ws.onmessage = function (e) { set(\"wsrel\", \"echo: \" + e.data); };",
  "  ws.onerror = function () { set(\"wsrel\", \"error\"); };",
  "  ws.onclose = function (e) { set(\"wsrel\", \"closed \" + e.code); };",
  "  setTimeout(function () { try { ws.send(\"wsprobe\"); } catch (e) {} }, 600);",
  "} catch (e) { set(\"wsrel\", \"throw: \" + String(e)); }",
  "try {",
  "  var ws2 = new WebSocket(\"wss://lobsterbrowse-fixture.onrender.com/ws\");",
  "  ws2.onopen = function () { set(\"wsabs\", \"open (direct)\"); };",
  "  ws2.onmessage = function (e) { set(\"wsabs\", \"echo: \" + e.data); };",
  "  ws2.onerror = function () { set(\"wsabs\", \"error\"); };",
  "  ws2.onclose = function (e) { set(\"wsabs\", \"closed \" + e.code); };",
  "  setTimeout(function () { try { ws2.send(\"wsprobe\"); } catch (e) {} }, 600);",
  "} catch (e) { set(\"wsabs\", \"throw: \" + String(e)); }",
  "</script></body></html>",
].join("");

function handler(req, res) {
  const p = new URL(req.url, "http://x").pathname;
  if (p === "/" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(HTML);
  }
  if (p === "/style.css" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/css" });
    return res.end(CSS);
  }
  if (p === "/app.js" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/javascript" });
    return res.end(JS);
  }
  if (p === "/data.json" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON_BODY);
  }
  if (p === "/redirect" && req.method === "GET") {
    res.writeHead(302, { location: "/" });
    return res.end();
  }
  if (p === "/echo" && req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ method: req.method, body, contentType: req.headers["content-type"] || "" }));
    });
    return;
  }
  if (p === "/stream" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    let i = 0;
    const t = setInterval(() => {
      if (i >= streamChunks.length) { clearInterval(t); return res.end(); }
      res.write(streamChunks[i++]);
    }, 5);
    return;
  }
  if (p === "/large" && req.method === "GET") {
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = m ? parseInt(m[1], 10) : -1;
      const end = m && m[2] !== "" ? parseInt(m[2], 10) : LARGE_SIZE - 1;
      if (!m || start >= LARGE_SIZE || end >= LARGE_SIZE || start > end) {
        res.writeHead(416, { "content-type": "text/plain" });
        return res.end("bad range");
      }
      res.writeHead(206, {
        "content-type": "application/octet-stream",
        "content-range": "bytes " + start + "-" + end + "/" + LARGE_SIZE,
        "accept-ranges": "bytes",
      });
      return res.end(large.subarray(start, end + 1));
    }
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "accept-ranges": "bytes",
      "content-length": String(LARGE_SIZE),
    });
    return res.end(large);
  }
  if (p === "/set-cookie" && req.method === "GET") {
    res.setHeader("set-cookie", ["zlprobe=a; Path=/; Max-Age=3600", "zlprobe2=b; Path=/; Max-Age=3600"]);
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("set");
  }
  if (p === "/cookie" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end(req.headers.cookie || "");
  }
  if (p === "/sse" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    let i = 0;
    const t = setInterval(() => {
      if (i >= 3) { clearInterval(t); return res.end(); }
      i++;
      res.write("data: tick " + i + "\n\n");
    }, 5);
    return;
  }
  if (p === "/hdrs" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(req.headers));
  }
  if (p === "/set-cookie1" && req.method === "GET") {
    res.setHeader("set-cookie", ["zlprobe1=a; Path=/; Max-Age=3600"]);
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("set1");
  }
  if (p === "/worker.js" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/javascript" });
    return res.end(WORKER_JS);
  }
  if (p === "/module-worker.js" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/javascript" });
    return res.end(MODULE_WORKER_JS);
  }
  if (p === "/workers.html" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(WORKERS_HTML);
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

/* Minimal RFC6455 echo for the /ws probe: handshake + one masked client
   text frame -> one unmasked server text frame. Nothing else. */
function wsUpgrade(req, socket) {
  const p = new URL(req.url, "http://x").pathname;
  if (p !== "/ws") { socket.destroy(); return; }
  const accept = crypto
    .createHash("sha1")
    .update((req.headers["sec-websocket-key"] || "") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  let buf = Buffer.alloc(0);
  socket.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskOff = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = buf.subarray(off, off + len);
      if (masked) {
        const mask = buf.subarray(maskOff, maskOff + 4);
        const clear = Buffer.alloc(len);
        for (let i = 0; i < len; i++) clear[i] = payload[i] ^ mask[i & 3];
        payload = clear;
      }
      buf = buf.subarray(off + len);
      if (opcode === 1) {
        const f = Buffer.from(payload.toString("utf8"), "utf8");
        let head;
        if (f.length < 126) { head = Buffer.from([0x81, f.length]); }
        else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(f.length, 2); }
        socket.write(Buffer.concat([head, f]));
      }
      if (opcode === 8) { socket.write(Buffer.from([0x88, 0])); socket.end(); return; }
    }
  });
}

export function startFixture(port = 0, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.on("upgrade", wsUpgrade);
    server.listen(port, host, () => {
      resolve({
        port: server.address().port,
        origin: "http://" + host + ":" + server.address().port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

if (process.argv[1] && process.argv[1].endsWith("fixture.mjs")) {
  const f = await startFixture(Number(process.env.PORT) || 3999, process.env.FIXTURE_HOST || "127.0.0.1");
  console.log("tier-0 fixture on " + f.origin + " (ctrl-c to stop)");
}
