/* AMO file.hash is algorithm-prefixed (sha256:<hex>), not a bare
   digest. Unknown algorithms must not disable verification. */
export async function verifyAmoPackage(bytes: Uint8Array<ArrayBuffer>, size: number, hash: string): Promise<void> {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("add-on download metadata has no valid package size");
  if (bytes.length !== size) throw new Error(`add-on size mismatch (expected ${size} B, got ${bytes.length} B)`);
  const expected = /^(?:sha256:)?([a-f0-9]{64})$/i.exec(hash.trim());
  if (!expected) throw new Error("add-on download metadata has an invalid or unsupported hash (SHA-256 required)");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== expected[1].toLowerCase()) throw new Error("add-on sha256 mismatch (download was tampered or truncated)");
}
