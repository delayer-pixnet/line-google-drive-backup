import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processQueueMessage } from "../src/index";
import type { Env, QueueJob } from "../src/types";

const sensitiveValues = {
  lineUserId: "U1234567890sensitive",
  messageId: "msg-sensitive-001",
  replyToken: "reply-token-sensitive",
  rawText: "不可出現在 Log 的原始文字",
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
  lineUserId: sensitiveValues.lineUserId,
  groupId: null,
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

function createEnv(enablePushFallback = false): Env {
  return {
    BACKUP_QUEUE: {} as Queue<QueueJob>,
    LINE_CHANNEL_SECRET: "line-signature-secret",
    LINE_CHANNEL_ACCESS_TOKEN: sensitiveValues.lineToken,
    GAS_ENDPOINT_URL: "https://example.invalid/exec",
    WORKER_GAS_SHARED_SECRET: sensitiveValues.sharedSecret,
    BIND_TOKEN_SECRET: "bind-token-secret-sensitive",
    IDENTIFIER_HASH_SECRET: sensitiveValues.identifierSecret,
    ENABLE_PUSH_FALLBACK: String(enablePushFallback),
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

  it("Reply Token 失效且 fallback 開啟時，Push 成功後仍只 ack", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, replyMessage: "綁定完成。" }))
      .mockResolvedValueOnce(Response.json(
        { message: "Invalid reply token" },
        { status: 400 },
      ))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const current = createMessage();

    await processQueueMessage(current.message, createEnv(true));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("/message/push");
    const pushInit = fetchMock.mock.calls[2]?.[1] as RequestInit;
    expect(JSON.parse(typeof pushInit.body === "string" ? pushInit.body : "")).toEqual({
      to: sensitiveValues.lineUserId,
      messages: [{ type: "text", text: "綁定完成。" }],
    });
    expect(current.ack).toHaveBeenCalledOnce();
    expect(current.retry).not.toHaveBeenCalled();
  });

  it("Push 失敗不會重新執行備份或重試 Queue", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, replyMessage: "綁定完成。" }))
      .mockResolvedValueOnce(Response.json(
        { message: "Invalid reply token" },
        { status: 400 },
      ))
      .mockResolvedValueOnce(new Response("", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const current = createMessage();

    await processQueueMessage(current.message, createEnv(true));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(current.ack).toHaveBeenCalledOnce();
    expect(current.retry).not.toHaveBeenCalled();
    const serializedLogs = logOutput.join("\n");
    for (const sensitiveValue of Object.values(sensitiveValues)) {
      expect(serializedLogs).not.toContain(sensitiveValue);
    }
    expect(serializedLogs).toContain("LINE_PUSH_FAILED");
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
});
