import { afterEach, describe, expect, it, vi } from "vitest";
import { callGas, createGasEnvelope } from "../src/gas-client";
import type { QueueJob } from "../src/types";

const testJob: QueueJob = {
  schemaVersion: 1,
  eventType: "message",
  webhookEventId: "evt-gas-client",
  messageId: "msg-gas-client",
  messageType: "text",
  lineUserId: "U1234567890abcdef",
  groupId: null,
  replyToken: "reply-token",
  timestamp: 1_785_456_000_000,
  fileName: null,
  fileSize: null,
  rawText: "測試文字",
  command: null,
  shouldSave: true,
  rejectionCode: null,
  bindToken: null,
};

describe("GAS client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("接受正常 JSON 回應並送出簽署 envelope", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ ok: true, replyMessage: "備份完成。" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callGas(
      "https://example.invalid/exec",
      "shared-secret-for-test",
      testJob,
      5000,
    );

    expect(result).toEqual({ ok: true, replyMessage: "備份完成。" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(typeof requestInit.body).toBe("string");
    const envelope = JSON.parse(
      typeof requestInit.body === "string" ? requestInit.body : "",
    ) as Record<string, unknown>;
    expect(envelope).toMatchObject({ payload: JSON.stringify(testJob) });
    expect(envelope.signature).toMatch(/^[a-f0-9]{64}$/u);
    expect(envelope.nonce).toMatch(/^[a-f0-9]{32}$/u);
  });

  it("解析備份成功 Reply 標記", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      ok: true,
      backupSuccessReply: true,
      replyMessage: "✅ 文字已備份",
    })));

    await expect(callGas(
      "https://example.invalid/exec",
      "shared-secret-for-test",
      testJob,
      5000,
    )).resolves.toMatchObject({
      ok: true,
      backupSuccessReply: true,
      replyMessage: "✅ 文字已備份",
    });
  });

  it("診斷關閉時不產生 Worker 指紋", async () => {
    const envelope = await createGasEnvelope(
      testJob,
      "shared-secret-for-test",
      1_735_689_600_000,
      "0123456789abcdef0123456789abcdef",
    );

    expect(envelope).not.toHaveProperty("workerDiagnostic");
  });

  it("診斷開啟時產生固定長度 Worker 指紋", async () => {
    const envelope = await createGasEnvelope(
      testJob,
      "shared-secret-for-test",
      1_735_689_600_000,
      "0123456789abcdef0123456789abcdef",
      true,
    );

    expect(envelope.workerDiagnostic?.workerSecretFingerprint).toMatch(/^[a-f0-9]{16}$/u);
    expect(envelope.workerDiagnostic?.workerSigningInputFingerprint).toMatch(/^[a-f0-9]{16}$/u);
    expect(envelope.workerDiagnostic?.workerSignaturePrefix).toMatch(/^[a-f0-9]{16}$/u);
  });

  it("只解析安全格式的 GAS 診斷指紋", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      ok: false,
      retryable: false,
      errorCode: "SIGNATURE_INVALID",
      diagnostic: {
        gasSecretFingerprint: "a".repeat(16),
        gasSigningInputFingerprint: "b".repeat(16),
        gasExpectedSignaturePrefix: "c".repeat(16),
        gasProvidedSignaturePrefix: "d".repeat(16),
        gasScriptIdSuffix: "Abc123-_",
        payload: "不得保留",
      },
    })));

    const result = await callGas(
      "https://example.invalid/exec",
      "shared-secret-for-test",
      testJob,
      5000,
      true,
    );

    expect(result.diagnostic).toEqual({
      gasSecretFingerprint: "a".repeat(16),
      gasSigningInputFingerprint: "b".repeat(16),
      gasExpectedSignaturePrefix: "c".repeat(16),
      gasProvidedSignaturePrefix: "d".repeat(16),
      gasScriptIdSuffix: "Abc123-_",
    });
    expect(JSON.stringify(result)).not.toContain("不得保留");
  });

  it.each([30, 605, 900])(
    "接受 30 至 900 秒內的 retryAfterSeconds：%i",
    async (retryAfterSeconds) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
        ok: false,
        retryable: true,
        errorCode: "JOB_IN_PROGRESS",
        retryAfterSeconds,
      })));

      await expect(callGas("https://example.invalid/exec", "secret", testJob, 5000))
        .resolves.toMatchObject({ retryAfterSeconds });
    },
  );

  it.each([29, 901, 60.5, "60"])(
    "忽略無效 retryAfterSeconds：%s",
    async (retryAfterSeconds) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
        ok: false,
        retryable: true,
        errorCode: "JOB_IN_PROGRESS",
        retryAfterSeconds,
      })));

      await expect(callGas("https://example.invalid/exec", "secret", testJob, 5000))
        .resolves.not.toHaveProperty("retryAfterSeconds");
    },
  );

  it.each([302, 401, 403, 404, 500])(
    "保留 GAS HTTP %i 的安全回應欄位",
    async (status) => {
      const contentType = status === 500 ? "application/json; charset=utf-8" : "text/html; charset=utf-8";
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
        new Response(status === 500 ? "not-json" : "<html>拒絕</html>", {
          status,
          headers: { "content-type": contentType },
        }),
      ));

      await expect(callGas("https://example.invalid/exec", "secret", testJob, 5000))
        .rejects.toMatchObject({
          errorCode: "GAS_HTTP_ERROR",
          retryable: status >= 500,
          httpStatus: status,
          contentType: contentType.split(";", 1)[0],
          redirected: false,
        });
    },
  );

  it("只解析 JSON HTTP 錯誤的安全錯誤碼與診斷指紋", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(
      {
        ok: false,
        retryable: false,
        errorCode: "SIGNATURE_INVALID",
        diagnostic: {
          gasSecretFingerprint: "a".repeat(16),
          gasScriptIdSuffix: "Abc123-_",
          payload: "不得記錄",
        },
        payload: "不得記錄",
      },
      { status: 401 },
    )));

    await expect(callGas("https://example.invalid/exec", "secret", testJob, 5000, true))
      .rejects.toMatchObject({
        errorCode: "GAS_HTTP_ERROR",
        httpStatus: 401,
        contentType: "application/json",
        upstreamErrorCode: "SIGNATURE_INVALID",
        diagnostic: {
          gasSecretFingerprint: "a".repeat(16),
          gasScriptIdSuffix: "Abc123-_",
        },
      });
  });

  it("拒絕無效 JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("not-json", { status: 200, headers: { "content-type": "text/plain" } }),
    ));

    await expect(callGas("https://example.invalid/exec", "secret", testJob, 5000))
      .rejects.toMatchObject({
        errorCode: "GAS_HTTP_ERROR",
        retryable: true,
        httpStatus: 200,
        contentType: "text/plain",
        redirected: false,
      });
  });
});
