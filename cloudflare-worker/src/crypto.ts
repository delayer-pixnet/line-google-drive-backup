const encoder = new TextEncoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function toBase64Url(value: string): string {
  return bytesToBase64(encoder.encode(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function fromBase64Url(value: string): string | null {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  const bytes = base64ToBytes(padded);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function hmacSha256Bytes(
  secret: string,
  message: string,
): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importHmacKey(secret),
    encoder.encode(message),
  );
  return new Uint8Array(signature);
}

export async function hmacSha256Base64(
  secret: string,
  message: string,
): Promise<string> {
  return bytesToBase64(await hmacSha256Bytes(secret, message));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const bytes = await hmacSha256Bytes(secret, message);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function computeWorkerEnvelopeSignature(
  timestamp: string | number,
  nonce: string,
  payload: string,
  secret: string,
): Promise<string> {
  const signingInput = `${String(timestamp)}.${nonce}.${payload}`;
  return hmacSha256Hex(secret, signingInput);
}

export async function sha256Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(message));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const maximumLength = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < maximumLength; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

export async function verifyLineSignature(
  rawBody: string,
  providedSignature: string,
  channelSecret: string,
): Promise<boolean> {
  const expected = await hmacSha256Base64(channelSecret, rawBody);
  return constantTimeEqual(expected, providedSignature);
}

interface BindTokenPayload {
  readonly version: 2;
  readonly lineUserHash: string;
  readonly expiresAt: number;
  readonly nonce: string;
}

export async function createBindToken(
  lineUserHash: string,
  secret: string,
  nowMilliseconds: number,
  ttlSeconds: number,
  nonce: string = crypto.randomUUID().replaceAll("-", ""),
): Promise<string> {
  const payload: BindTokenPayload = {
    version: 2,
    lineUserHash,
    expiresAt: nowMilliseconds + ttlSeconds * 1000,
    nonce,
  };
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = await hmacSha256Hex(secret, encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export async function verifyBindToken(
  token: string,
  secret: string,
  nowMilliseconds: number,
): Promise<BindTokenPayload | null> {
  const parts = token.split(".");
  const encodedPayload = parts[0];
  const signature = parts[1];
  if (parts.length !== 2 || encodedPayload === undefined || signature === undefined) {
    return null;
  }
  const expected = await hmacSha256Hex(secret, encodedPayload);
  if (!constantTimeEqual(expected, signature)) {
    return null;
  }
  const decodedPayload = fromBase64Url(encodedPayload);
  if (decodedPayload === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(decodedPayload);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      parsed.version !== 2 ||
      !("lineUserHash" in parsed) ||
      typeof parsed.lineUserHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(parsed.lineUserHash) ||
      !("expiresAt" in parsed) ||
      typeof parsed.expiresAt !== "number" ||
      parsed.expiresAt < nowMilliseconds ||
      !("nonce" in parsed) ||
      typeof parsed.nonce !== "string" ||
      !/^[a-f0-9]{16,64}$/u.test(parsed.nonce)
    ) {
      return null;
    }
    return {
      version: 2,
      lineUserHash: parsed.lineUserHash,
      expiresAt: parsed.expiresAt,
      nonce: parsed.nonce,
    };
  } catch {
    return null;
  }
}

export function createNonce(): string {
  return crypto.randomUUID().replaceAll("-", "");
}
