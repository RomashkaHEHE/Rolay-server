import { createHash } from "node:crypto";

const SHA256_PREFIX = "sha256:";
const SHA256_BYTES = 32;

function padBase64(value: string): string {
  const remainder = value.length % 4;
  if (remainder === 0) {
    return value;
  }

  return `${value}${"=".repeat(4 - remainder)}`;
}

function stripSha256Prefix(hash: string): string {
  if (!hash.startsWith(SHA256_PREFIX)) {
    throw new Error('Hash must use the "sha256:<digest>" format.');
  }

  const digest = hash.slice(SHA256_PREFIX.length).trim();
  if (digest.length === 0) {
    throw new Error('Hash must use the "sha256:<digest>" format.');
  }

  return digest;
}

export function parseSha256HashBytes(hash: string): Buffer {
  const digest = stripSha256Prefix(hash);

  // Accept both canonical base64 and user-supplied hex digests so desktop clients do not need to
  // perfectly coordinate encoding details with the server before upload starts.
  if (/^[0-9a-fA-F]{64}$/.test(digest)) {
    return Buffer.from(digest, "hex");
  }

  if (!/^[A-Za-z0-9+/_=-]+$/.test(digest)) {
    throw new Error('Hash must use the "sha256:<digest>" format.');
  }

  const normalizedBase64 = padBase64(digest.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Buffer.from(normalizedBase64, "base64");
  if (bytes.byteLength !== SHA256_BYTES) {
    throw new Error("SHA-256 digest must be 32 bytes.");
  }

  return bytes;
}

export function formatSha256Hash(bytes: Uint8Array): string {
  return `${SHA256_PREFIX}${Buffer.from(bytes).toString("base64")}`;
}

export function normalizeSha256Hash(hash: string): string {
  return formatSha256Hash(parseSha256HashBytes(hash));
}

export function sha256HashFromPayload(payload: Uint8Array): string {
  return formatSha256Hash(createHash("sha256").update(payload).digest());
}

export function sha256HashDigestToken(hash: string): string {
  return normalizeSha256Hash(hash)
    .replace(/^sha256:/, "")
    .replace(/[^A-Za-z0-9_-]/g, "_");
}

export function trySha256HashDigestTokens(hash: string): string[] {
  const digests = new Set<string>();

  // Older persisted blob objects may already be keyed by whatever digest text the client sent
  // before the server started canonicalizing hashes. Keep those lookup candidates alive so new
  // code can still read previously stored payloads without migration.
  const legacyToken = hash.replace(/^sha256:/, "").replace(/[^A-Za-z0-9_-]/g, "_");
  if (legacyToken.length > 0) {
    digests.add(legacyToken);
  }

  try {
    digests.add(sha256HashDigestToken(hash));
  } catch {
    // Keep supporting legacy persisted objects that may already be keyed by the raw digest string.
  }

  return [...digests];
}
