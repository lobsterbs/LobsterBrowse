import http from "node:http";

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
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

export function startFixture(port = 0, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
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
