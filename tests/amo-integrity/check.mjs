import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyAmoPackage } from "../../ui/src/browser/amoIntegrity.ts";
const bytes = new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3, 4]);
const hash = createHash("sha256").update(bytes).digest("hex");
await verifyAmoPackage(bytes, bytes.length, "sha256:" + hash);
await verifyAmoPackage(bytes, bytes.length, "SHA256:" + hash.toUpperCase());
await verifyAmoPackage(bytes, bytes.length, hash);
const changed = bytes.slice(); changed[7] ^= 1;
await assert.rejects(verifyAmoPackage(changed, bytes.length, "sha256:" + hash), /sha256 mismatch/);
await assert.rejects(verifyAmoPackage(bytes.slice(0, -1), bytes.length, "sha256:" + hash), /size mismatch/);
for (const invalid of ["", "sha256:abc", "sha512:" + hash, "sha256:" + "z".repeat(64)]) {
  await assert.rejects(verifyAmoPackage(bytes, bytes.length, invalid), /invalid or unsupported hash/);
}
for (const invalid of [0, -1, NaN, Infinity, 1.5]) {
  await assert.rejects(verifyAmoPackage(bytes, invalid, "sha256:" + hash), /no valid package size/);
}
console.log("AMO integrity: correct prefixed hashes accepted; changed bytes and invalid metadata refused");
