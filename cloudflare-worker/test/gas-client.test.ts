import { afterEach, describe, expect, it, vi } from "vitest";
import { callGas } from "../src/gas-client";
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

  it("將 GAS HTTP 500 標示為可重試", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));

    await expect(callGas("https://example.invalid/exec", "secret", testJob, 5000))
      .rejects.toMatchObject({
        errorCode: "GAS_HTTP_ERROR",
        retryable: true,
      });
  });

  it("將 GAS HTTP 400 標示為不可重試", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 400 })));

    await expect(callGas("https://example.invalid/exec", "secret", testJob, 5000))
      .rejects.toMatchObject({
        errorCode: "GAS_HTTP_ERROR",
        retryable: false,
      });
  });

  it("拒絕無效 JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("not-json", { status: 200, headers: { "content-type": "text/plain" } }),
    ));

    await expect(callGas("https://example.invalid/exec", "secret", testJob, 5000))
      .rejects.toMatchObject({
        errorCode: "GAS_INVALID_JSON",
        retryable: true,
      });
  });
});
