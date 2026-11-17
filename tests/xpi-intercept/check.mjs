/* Regression check for the .xpi download interception chain: the
   fixture serves a real add-on package (a hand-built deterministic
   STORE zip) plus the download page that links it, and the UI chain
   (click capture -> in-memory .xpi hold -> install prompt ->
   zl:installExt) stays wired. The fixture half is functional (boots
   the real fixture server); the UI half is static source asserts.
   The live through-the-engine pass runs in the browser harness.

   Run from the repo root:
     node --experimental-strip-types tests/xpi-intercept/check.mjs */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startFixture, xpiBytes } from "../transit/fixture.mjs";

const fx = await startFixture(0);
try {
  const dl = await fetch(fx.origin + "/dl.html");
  assert.equal(dl.status, 200, "the download page serves");
  const html = await dl.text();
  assert.ok(html.includes('id="xpi-link"'), "the download page carries the xpi anchor");
  assert.ok(html.includes('href="/probe.xpi"'), "the anchor points at the probe package");

  const xpi = await fetch(fx.origin + "/probe.xpi");
  assert.equal(xpi.status, 200, "the probe package serves");
  assert.equal(xpi.headers.get("content-type"), "application/x-xpinstall");
  const buf = Buffer.from(await xpi.arrayBuffer());
  assert.equal(buf.length, xpiBytes.length, "the served package is byte-stable");
  assert.ok(buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])), "zip local header magic");
  assert.ok(buf.subarray(buf.length - 22, buf.length - 18).equals(Buffer.from([0x50, 0x4b, 0x05, 0x06])), "zip EOCD magic");
  /* Single STORE entry: the manifest sits uncompressed right after
     the 30-byte local header + the entry name. */
  const nameLen = buf.readUInt16LE(26);
  const size = buf.readUInt32LE(18);
  assert.equal(buf.toString("utf8", 30, 30 + nameLen), "manifest.json", "the entry is manifest.json");
  const manifest = JSON.parse(buf.toString("utf8", 30 + nameLen, 30 + nameLen + size));
  assert.equal(manifest.manifest_version, 2, "the manifest is MV2");
  assert.equal(manifest.browser_specific_settings.gecko.id, "xpi-probe@fixture.example", "the gecko id is the probe id");
  const eocd = buf.length - 22;
  const cdOff = buf.readUInt32LE(eocd + 16);
  assert.equal(cdOff, 30 + nameLen + size, "the central directory follows the single entry");
  assert.equal(buf.readUInt32LE(cdOff + 16), buf.readUInt32LE(14), "central and local CRC agree");
  assert.equal(buf.readUInt16LE(eocd + 10), 1, "exactly one entry");
} finally {
  await fx.close();
}

/* UI half: static source asserts on the interception chain. */
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const shared = read("../../ui/src/browser/browserShared.ts");
assert.ok(shared.includes("zip|xpi|crx"), "DL_FILE_RE still catches .xpi links");
const browser = read("../../ui/src/pages/Browser.tsx");
assert.ok(browser.includes("setXpiPrompt({ name, got: 0, size: 0 })"), "the prompt opens immediately on click, not after the package arrives");
assert.ok(!browser.includes("<DownloadsCard") && !browser.includes("lb-dl-btn"), "the downloads card and toolbar button are gone");
assert.ok(browser.includes('zlSend({ type: "zl:installExt", bytes'), "install hands the bytes to the engine");
assert.ok(browser.includes("<XpiPrompt"), "the install prompt is mounted");
const prompt = read("../../ui/src/browser/XpiPrompt.tsx");
assert.ok(prompt.includes("m3e-linear-progress-indicator"), "the busy state shows live progress");
assert.ok(
  prompt.includes('return-value="install"') &&
  prompt.includes('return-value="save"') &&
  prompt.includes('return-value="cancel"'),
  "the prompt carries install, save and cancel actions",
);

console.log("xpi-intercept: fixture package, download page and UI chain checks passed");
