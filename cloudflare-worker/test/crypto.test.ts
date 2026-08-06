import { describe, expect, it } from "vitest";
import {
  createBindToken,
  computeWorkerEnvelopeSignature,
  hmacSha256Base64,
  hmacSha256Hex,
  verifyBindToken,
  verifyLineSignature,
} from "../src/crypto";

describe("HMAC", () => {
  it("產生並驗證 LINE HMAC-SHA256 簽章", async () => {
    const body = '{"events":[]}';
    const signature = await hmacSha256Base64("test-secret", body);

    await expect(verifyLineSignature(body, signature, "test-secret")).resolves.toBe(true);
    await expect(verifyLineSignature(`${body} `, signature, "test-secret")).resolves.toBe(false);
    await expect(hmacSha256Hex("key", "payload")).resolves.toMatch(/^[a-f0-9]{64}$/u);
  });

  it("UTF-8 HMAC-SHA256 與 GAS 共用固定測試向量", async () => {
    await expect(
      hmacSha256Hex("永久識別金鑰-測試", "LINE使用者-U繁體中文"),
    ).resolves.toBe(
      "7ec777e9164c89d93d0f6e67e2c22f76a1750cd75ee3b76611163dba8cd67cb6",
    );
  });

  it("Envelope HMAC 與 GAS 共用含繁體中文 Payload 的固定向量", async () => {
    const secret = "TEST_SECRET_1234567890";
    const timestamp = "2026-08-06T12:30:00.000Z";
    const nonce = "0123456789abcdef0123456789abcdef";
    const payload = "{\"message\":\"繁體中文測試\",\"ok\":true}";

    await expect(computeWorkerEnvelopeSignature(timestamp, nonce, payload, secret)).resolves.toBe(
      "5f3da90b2c65bf73c265fc32e667555e179dd65d9b3d3667c7b7c64ed8d6a9ca",
    );
  });
});

describe("短效綁定 Token", () => {
  const now = Date.UTC(2026, 6, 31, 0, 0, 0);
  const userId = "U1234567890abcdef";
  const userHash = "a".repeat(64);
  const nonce = "0123456789abcdef0123456789abcdef";

  it("可驗證有效 Token", async () => {
    const token = await createBindToken(userHash, "bind-secret", now, 600, nonce);
    const payload = await verifyBindToken(token, "bind-secret", now + 1000);

    expect(payload).toEqual({
      version: 2,
      lineUserHash: userHash,
      expiresAt: now + 600_000,
      nonce,
    });
    expect(token).not.toContain(userId);
    expect(JSON.stringify(payload)).not.toContain(userId);
  });

  it("拒絕過期 Token", async () => {
    const token = await createBindToken(userHash, "bind-secret", now, 1, nonce);

    await expect(verifyBindToken(token, "bind-secret", now + 1001)).resolves.toBeNull();
  });

  it("拒絕遭竄改 Token", async () => {
    const token = await createBindToken(userHash, "bind-secret", now, 600, nonce);
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

    await expect(verifyBindToken(tampered, "bind-secret", now)).resolves.toBeNull();
  });
});
