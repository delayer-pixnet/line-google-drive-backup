import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processQueueMessage } from "../src/index";
import type { Env, QueueJob } from "../src/types";

const sensitiveValues = {
  lineUserId: "U1234567890sensitive",
  messageId: "msg-sensitive-001",
  replyToken: "reply-token-sensitive",
  rawText: "不可出現在 Log 的原始文字",
  gasUrl: "https://example.invalid/exec",
  signature: "signature-sensitive",
  nonce: "nonce-sensitive",
  sharedSecret: "gas-shared-secret-sensitive",
  lineToken: "line-access-token-sensitive",
  identifierSecret: "identifier-hash-secret-sensitive",
};

const queueJob: QueueJob = {
  schemaVersion: 1,
  eventType: "message",
  webhookEventId: "evt-queue-001",
  messageId: sensitiveValues.messageId,
  messageType: "text",
  lineUserHash: "a".repeat(64),
  groupIdHash: null,
  senderDisplayName: "測試使用者",
  groupDisplayName: null,
  replyToken: sensitiveValues.replyToken,
  timestamp: 1_785_456_000_000,
  fileName: null,
  fileSize: null,
  rawText: sensitiveValues.rawText,
  command: null,
  shouldSave: true,
  rejectionCode: null,
  bindToken: null,
};

function createEnv(
  enablePushFallback = false,
  diagnosticEnabled = false,
  enableBackupSuccessReply = true,
): Env {
  return {
    BACKUP_QUEUE: {} as Queue<QueueJob>,
    LINE_CHANNEL_SECRET: "line-signature-secret",
    LINE_CHANNEL_ACCESS_TOKEN: sensitiveValues.lineToken,
    GAS_ENDPOINT_URL: sensitiveValues.gasUrl,
    WORKER_GAS_SHARED_SECRET: sensitiveValues.sharedSecret,
    BIND_TOKEN_SECRET: "bind-token-secret-sensitive",
    IDENTIFIER_HASH_SECRET: sensitiveValues.identifierSecret,
    ENABLE_BACKUP_SUCCESS_REPLY: String(enableBackupSuccessReply),
    ENABLE_PUSH_FALLBACK: String(enablePushFallback),
    HMAC_DIAGNOSTIC_ENABLED: String(diagnosticEnabled),
  };
}

function createMessage(): {
  readonly message: Message<QueueJob>;
  readonly ack: ReturnType<typeof vi.fn>;
  readonly retry: ReturnType<typeof vi.fn>;
} {
  const ack = vi.fn();
  const retry = vi.fn();
  return {
    message: { body: queueJob, ack, retry } as unknown as Message<QueueJob>,
    ack,
    retry,
  };
}

describe("Queue consumer", () => {
  const logOutput: string[] = [];

  beforeEach(() => {
    logOutput.length = 0;
    vi.spyOn(console, "info").mockImplementation((value: unknown) => {
      logOutput.push(String(value));
    });
    vi.spyOn(console, "warn").mockImplementation((value: unknown) => {
      logOutput.push(String(value));
    });
    vi.spyOn(console, "error").mockImplementation((value: unknown) => {
      logOutput.push(String(value));
    });
  });

  it("系統狀態在 Worker 層回覆，不依賴 GAS", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const current = createMessage();
    const systemMessage = {
      ...current.message,
      body: { ...queueJob, command: "systemStatus", shouldSave: false },
    } as unknown as Message<QueueJob>;

    await processQueueMessage(systemMessage, createEnv());

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/message/reply");
    const requestBodyValue = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body;
    const requestBody = typeof requestBodyValue === "string" ? requestBodyValue : JSON.stringify(requestBodyValue);
    expect(requestBody).toContain("Worker：正常");
    expect(requestBody).toContain("Queue：已設定");
    expect(current.ack).toHaveBeenCalledOnce();
    expect(current.retry).not.toHaveBeenCalled();
  });

  it("GAS 403 HTML 會使用 Reply API 提醒管理者授權", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("<html>forbidden</html>", {
        status: 403,
        headers: { "content-type": "text/html; charset=utf-8" },
      }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const current = createMessage();

    await processQueueMessage(current.message, createEnv());

    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/message/reply");
    const replyBodyValue = (fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body;
    const replyBody = typeof replyBodyValue === "string" ? replyBodyValue : JSON.stringify(replyBodyValue);
    expect(replyBody).toContain("testOwnerAuthorizationHealth");
    expect(current.ack).toHaveBeenCalledOnce();
    expect(current.retry).not.toHaveBeenCalled();
    expect(logOutput.join("\n")).not.toContain("<html>");
  });

  it("系統診斷可顯示最近 GAS 安全錯誤碼且不依賴 GAS", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      ok: false,
      retryable: false,
      errorCode: "GAS_AUTH_FAILED",
    })));
    await processQueueMessage(createMessage().message, createEnv());

    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const current = createMessage();
    const diagnosticMessage = {
      ...current.message,
      body: { ...queueJob, command: "systemStatus", rawText: "系統診斷", shouldSave: false },
    } as unknown as Message<QueueJob>;
    await processQueueMessage(diagnosticMessage, createEnv());

    const requestBodyValue = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body;
    const requestBody = typeof requestBodyValue === "string" ? requestBodyValue : JSON.stringify(requestBodyValue);
    expect(requestBody).toContain("最近 GAS 呼叫狀態：失敗");
    expect(requestBody).toContain("GAS_AUTH_FAILED");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(current.ack).toHaveBeenCalledOnce();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("GAS retryable 錯誤會 retry 而不 ack", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    const current = createMessage();

    await processQueueMessage(current.message, createEnv());

    expect(current.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(current.ack).not.toHaveBeenCalled();
  });

  it.each([302, 401, 403, 404, 500])(
    "GAS HTTP %i 只安全記錄狀態欄位",
    async (status) => {
      const htmlBody = `<html>${sensitiveValues.rawText} ${sensitiveValues.nonce}</html>`;
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(htmlBody, {
        status,
        headers: { "content-type": "text/html; charset=utf-8" },
      })));
      const current = createMessage();

      await processQueueMessage(current.message, createEnv());

      const serializedLogs = logOutput.join("\n");
      expect(serializedLogs).toContain(
        `"component":"gas","status":"http_error","correlationId":"evt-queue-001","errorCode":"GAS_HTTP_ERROR","httpStatus":${String(status)},"contentType":"text/html","redirected":false`,
      );
      expect(serializedLogs).not.toContain(htmlBody);
      for (const sensitiveValue of Object.values(sensitiveValues)) {
        expect(serializedLogs).not.toContain(sensitiveValue);
      }
      expect(current.ack).toHaveBeenCalledTimes(status >= 500 ? 0 : 1);
      expect(current.retry).toHaveBeenCalledTimes(status >= 500 ? 1 : 0);
    },
  );

  it("JSON HTTP 錯誤只記錄安全錯誤碼與診斷短指紋", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(
      {
        ok: false,
        retryable: false,
        errorCode: "SIGNATURE_INVALID",
        diagnostic: {
          gasSecretFingerprint: "a".repeat(16),
          gasScriptIdSuffix: "Abc123-_",
        },
        payload: sensitiveValues.rawText,
      },
      { status: 401 },
    )));
    const current = createMessage();

    await processQueueMessage(current.message, createEnv(false, true));

    const serializedLogs = logOutput.join("\n");
    expect(serializedLogs).toContain('"errorCode":"GAS_HTTP_ERROR"');
    expect(serializedLogs).toContain('"upstreamErrorCode":"SIGNATURE_INVALID"');
    expect(serializedLogs).toContain('"gasSecretFingerprint":"aaaaaaaaaaaaaaaa"');
    expect(serializedLogs).toContain('"gasScriptIdSuffix":"Abc123-_"');
    expect(serializedLogs).not.toContain(sensitiveValues.rawText);
    expect(serializedLogs).not.toContain(sensitiveValues.gasUrl);
    expect(serializedLogs).not.toContain(sensitiveValues.sharedSecret);
    expect(current.ack).toHaveBeenCalledOnce();
    expect(current.retry).not.toHaveBeenCalled();
  });

  it("GAS 業務回應標示 retryable 時會 retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      Response.json({ ok: false, retryable: true, errorCode: "TEMPORARY_FAILURE" }),
    ));
    const current = createMessage();

    await processQueueMessage(current.message, createEnv());

    expect(current.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(current.ack).not.toHaveBeenCalled();
  });

  it("PROCESSING 租約有效時使用 GAS 指定延遲且不可 ack", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      ok: false,
      retryable: true,
      errorCode: "JOB_IN_PROGRESS",
      retryAfterSeconds: 605,
    })));
    const current = createMessage();

    await processQueueMessage(current.message, createEnv());

    expect(current.retry).toHaveBeenCalledWith({ delaySeconds: 605 });
    expect(current.ack).not.toHaveBeenCalled();
    expect(logOutput.join("\n")).toContain('"errorCode":"JOB_IN_PROGRESS"');
  });

  it("無效 retryAfterSeconds 回退為 60 秒且不可 ack", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      ok: false,
      retryable: true,
      errorCode: "JOB_IN_PROGRESS",
      retryAfterSeconds: 901,
    })));
    const current = createMessage();

    await processQueueMessage(current.message, createEnv());

    expect(current.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(current.ack).not.toHaveBeenCalled();
  });

  it("原處理程序完成後，後續 Queue 重試會識別終態並 ack", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        ok: false,
        retryable: true,
        errorCode: "JOB_IN_PROGRESS",
        retryAfterSeconds: 30,
      }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const inProgress = createMessage();
    const completed = createMessage();

    await processQueueMessage(inProgress.message, createEnv());
    await processQueueMessage(completed.message, createEnv());

    expect(inProgress.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(inProgress.ack).not.toHaveBeenCalled();
    expect(completed.ack).toHaveBeenCalledOnce();
    expect(completed.retry).not.toHaveBeenCalled();
  });

  it("GAS non-retryable 錯誤會 ack", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 400 })));
    const current = createMessage();

    await processQueueMessage(current.message, createEnv());

    expect(current.ack).toHaveBeenCalledOnce();
    expect(current.retry).not.toHaveBeenCalled();
  });

  it("OAuth 失效回應會 Reply 後 ACK，不會重新執行工作", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        ok: true,
        replyMessage: "Google 授權已失效，請重新授權。",
      }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const current = createMessage();

    await processQueueMessage(current.message, createEnv());

    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/message/reply");
    expect(current.ack).toHaveBeenCalledOnce();
    expect(current.retry).not.toHaveBeenCalled();
  });

  it("個人備份成功使用 Reply API 回覆，且不使用 Push", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        ok: true,
        backupSuccessReply: true,
        replyMessage: "✅ 圖片已備份",
      }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const current = createMessage();
    const attachmentMessage = {
      ...current.message,
      body: { ...queueJob, messageType: "image", rawText: null },
    } as unknown as Message<QueueJob>;

    await processQueueMessage(attachmentMessage, createEnv(true));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/message/reply");
    expect(String(fetchMock.mock.calls[1]?.[0])).not.toContain("/message/push");
    expect(current.ack).toHaveBeenCalledOnce();
    expect(current.retry).not.toHaveBeenCalled();
  });

  it("紀錄查詢只使用 Reply API，Reply 失效也不改用 Push", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        ok: true,
        replyMessage: "請開啟查詢連結。",
      }))
      .mockResolvedValueOnce(Response.json(
        { message: "Invalid reply token" },
        { status: 400 },
      ));
    vi.stubGlobal("fetch", fetchMock);
    const current = createMessage();
    const recordsMessage = {
      ...current.message,
      body: { ...queueJob, command: "records", shouldSave: false },
    } as unknown as Message<QueueJob>;

    await processQueueMessage(recordsMessage, createEnv(true));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/message/reply");
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/message/push"))).toBe(false);
    expect(current.ack).toHaveBeenCalledOnce();
    expect(current.retry).not.toHaveBeenCalled();
  });

  it("群組附件成功不回覆以避免洗版", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      ok: true,
      backupSuccessReply: true,
      replyMessage: "✅ 圖片已備份",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const current = createMessage();
    const groupMessage = {
      ...current.message,
      body: {
        ...queueJob,
        messageType: "image",
        groupIdHash: "b".repeat(64),
        groupDisplayName: "測試群組",
        rawText: null,
      },
    } as unknown as Message<QueueJob>;

    await processQueueMessage(groupMessage, createEnv(true));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(current.ack).toHaveBeenCalledOnce();
    expect(current.retry).not.toHaveBeenCalled();
  });

  it("備份成功 Reply 失敗不會重做備份或改用 Push", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        ok: true,
        backupSuccessReply: true,
        replyMessage: "✅ 文字已備份",
      }))
      .mockResolvedValueOnce(Response.json(
        { message: "Invalid reply token" },
        { status: 400 },
      ));
    vi.stubGlobal("fetch", fetchMock);
    const current = createMessage();

    await processQueueMessage(current.message, createEnv(true));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/message/reply");
    expect(current.ack).toHaveBeenCalledOnce();
    expect(current.retry).not.toHaveBeenCalled();
  });

  it("停用備份成功 Reply 時只 ACK，不呼叫 Reply API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      ok: true,
      backupSuccessReply: true,
      replyMessage: "✅ 文字已備份",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const current = createMessage();

    await processQueueMessage(current.message, createEnv(false, false, false));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(current.ack).toHaveBeenCalledOnce();
  });

  it.each(["SIGNATURE_INVALID", "NONCE_INVALID"])(
    "GAS %s 會安全記錄並以 acknowledged 結束",
    async (errorCode) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
        ok: false,
        retryable: false,
        errorCode,
      })));
      const current = createMessage();

      await processQueueMessage(current.message, createEnv());

      const serializedLogs = logOutput.join("\n");
      expect(serializedLogs).toContain(
        `"component":"gas","status":"rejected","correlationId":"evt-queue-001","errorCode":"${errorCode}"`,
      );
      expect(serializedLogs).toContain(
        '"component":"queue","status":"acknowledged","correlationId":"evt-queue-001"',
      );
      expect(serializedLogs).not.toContain('"status":"completed"');
      for (const sensitiveValue of Object.values(sensitiveValues)) {
        expect(serializedLogs).not.toContain(sensitiveValue);
      }
      expect(current.ack).toHaveBeenCalledOnce();
      expect(current.retry).not.toHaveBeenCalled();
    },
  );

  it("Push fallback 關閉時，Reply Token 失效只 ack 且不重做 GAS 工作", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, replyMessage: "備份完成。" }))
      .mockResolvedValueOnce(Response.json(
        { message: "Invalid reply token" },
        { status: 400 },
      ));
    vi.stubGlobal("fetch", fetchMock);
    const current = createMessage();

    await processQueueMessage(current.message, createEnv());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("example.invalid");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("api.line.me");
    expect(current.ack).toHaveBeenCalledOnce();
    expect(current.retry).not.toHaveBeenCalled();
  });

  it("即使 fallback 設定開啟，Queue metadata 沒有 raw recipient 也不呼叫 Push", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, replyMessage: "綁定完成。" }))
      .mockResolvedValueOnce(Response.json(
        { message: "Invalid reply token" },
        { status: 400 },
      ))
    vi.stubGlobal("fetch", fetchMock);
    const current = createMessage();

    await processQueueMessage(current.message, createEnv(true));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/message/reply");
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/message/push"))).toBe(false);
    expect(current.ack).toHaveBeenCalledOnce();
    expect(current.retry).not.toHaveBeenCalled();
  });

  it("Reply 失敗不會重新執行備份或重試 Queue", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, replyMessage: "綁定完成。" }))
      .mockResolvedValueOnce(Response.json(
        { message: "Invalid reply token" },
        { status: 400 },
      ))
    vi.stubGlobal("fetch", fetchMock);
    const current = createMessage();

    await processQueueMessage(current.message, createEnv(true));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(current.ack).toHaveBeenCalledOnce();
    expect(current.retry).not.toHaveBeenCalled();
    const serializedLogs = logOutput.join("\n");
    for (const sensitiveValue of Object.values(sensitiveValues)) {
      expect(serializedLogs).not.toContain(sensitiveValue);
    }
    expect(serializedLogs).toContain("LINE_REPLY_TOKEN_INVALID");
  });

  it("一般成功附件沒有 replyMessage 時不會自動 Push", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const current = createMessage();
    const attachmentMessage = {
      ...current.message,
      body: {
        ...queueJob,
        messageType: "image",
        rawText: null,
        command: null,
      },
    } as unknown as Message<QueueJob>;

    await processQueueMessage(attachmentMessage, createEnv(true));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(current.ack).toHaveBeenCalledOnce();
    expect(current.retry).not.toHaveBeenCalled();
  });

  it("GAS 已去重的重複工作只 ack，不觸發其他外部呼叫", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const current = createMessage();

    await processQueueMessage(current.message, createEnv());

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(current.ack).toHaveBeenCalledOnce();
    expect(current.retry).not.toHaveBeenCalled();
  });

  it("安全 Log 不含 Secret、Token、原始文字或 LINE／訊息識別碼", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    const current = createMessage();

    await processQueueMessage(current.message, createEnv());

    const serializedLogs = logOutput.join("\n");
    for (const sensitiveValue of Object.values(sensitiveValues)) {
      expect(serializedLogs).not.toContain(sensitiveValue);
    }
    expect(serializedLogs).toContain("evt-queue-001");
  });

  it("診斷開啟時記錄 GAS 指紋，關閉時不記錄", async () => {
    const response = Response.json({
      ok: false,
      retryable: false,
      errorCode: "SIGNATURE_INVALID",
      diagnostic: {
        gasSecretFingerprint: "a".repeat(16),
        gasSigningInputFingerprint: "b".repeat(16),
        gasExpectedSignaturePrefix: "c".repeat(16),
        gasProvidedSignaturePrefix: "d".repeat(16),
        gasScriptIdSuffix: "Abc123-_",
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const current = createMessage();

    await processQueueMessage(current.message, createEnv(false, true));

    const diagnosticLogs = logOutput.join("\n");
    expect(diagnosticLogs).toContain('"gasSecretFingerprint":"aaaaaaaaaaaaaaaa"');
    expect(diagnosticLogs).toContain('"gasScriptIdSuffix":"Abc123-_"');
    expect(diagnosticLogs).not.toContain(sensitiveValues.rawText);
    expect(diagnosticLogs).not.toContain(sensitiveValues.lineUserId);
    expect(diagnosticLogs).not.toContain(sensitiveValues.sharedSecret);
    expect(diagnosticLogs).not.toContain(sensitiveValues.gasUrl);

    logOutput.length = 0;
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
      },
    })));
    await processQueueMessage(createMessage().message, createEnv(false, false));
    expect(logOutput.join("\n")).not.toContain("gasSecretFingerprint");
  });
});
