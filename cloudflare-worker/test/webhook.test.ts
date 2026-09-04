import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hmacSha256Base64,
  hmacSha256Hex,
  verifyBindToken,
} from "../src/crypto";
import { handleRequest } from "../src/index";
import type { Env, QueueJob } from "../src/types";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation((input: Request | URL | string) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(url.includes("/summary")
      ? Response.json({ groupName: "測試群組" })
      : Response.json({ displayName: "測試使用者" }));
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function createEnv(
  sentJobs: QueueJob[],
  bindTokenSecret = "bind-secret",
  identifierHashSecret = "identifier-secret",
): Env {
  const queue = {
    send: (job: QueueJob): Promise<void> => {
      sentJobs.push(job);
      return Promise.resolve();
    },
  } as unknown as Queue<QueueJob>;
  return {
    BACKUP_QUEUE: queue,
    LINE_CHANNEL_SECRET: "line-secret",
    LINE_CHANNEL_ACCESS_TOKEN: "line-access-token-for-test",
    GAS_ENDPOINT_URL: "https://example.invalid/exec",
    WORKER_GAS_SHARED_SECRET: "gas-secret",
    BIND_TOKEN_SECRET: bindTokenSecret,
    IDENTIFIER_HASH_SECRET: identifierHashSecret,
    MAX_FILE_SIZE_BYTES: String(20 * 1024 * 1024),
  };
}

async function signedRequest(body: string, valid = true): Promise<Request> {
  const signature = await hmacSha256Base64("line-secret", body);
  return new Request("https://worker.example/webhook", {
    method: "POST",
    headers: { "x-line-signature": valid ? signature : "invalid" },
    body,
  });
}

describe("LINE Webhook", () => {
  it("合法簽章會快速接受並將中繼資料放入 Queue", async () => {
    const sentJobs: QueueJob[] = [];
    const body = JSON.stringify({
      events: [
        {
          type: "message",
          webhookEventId: "evt-001",
          timestamp: 1_785_456_000_000,
          replyToken: "reply-token",
          source: { type: "user", userId: "U1234567890abcdef" },
          message: { type: "file", id: "msg-001", fileName: "report.pdf", fileSize: 1024 },
        },
      ],
    });

    const response = await handleRequest(await signedRequest(body), createEnv(sentJobs));

    expect(response.status).toBe(200);
    expect(sentJobs).toHaveLength(1);
    expect(sentJobs[0]).toMatchObject({
      webhookEventId: "evt-001",
      messageId: "msg-001",
      messageType: "file",
      lineUserHash: await hmacSha256Hex("identifier-secret", "U1234567890abcdef"),
      groupIdHash: null,
      senderDisplayName: "測試使用者",
      groupDisplayName: null,
      fileName: "report.pdf",
      fileSize: 1024,
      rawText: null,
    });
  });

  it("非法簽章回傳 401 且不排入工作", async () => {
    const sentJobs: QueueJob[] = [];
    const response = await handleRequest(
      await signedRequest('{"events":[]}', false),
      createEnv(sentJobs),
    );

    expect(response.status).toBe(401);
    expect(sentJobs).toHaveLength(0);
  });

  it("空 Body 回傳 400", async () => {
    const response = await handleRequest(
      new Request("https://worker.example/webhook", { method: "POST", body: "" }),
      createEnv([]),
    );

    expect(response.status).toBe(400);
  });

  it("不支援事件會安全忽略", async () => {
    const sentJobs: QueueJob[] = [];
    const body = JSON.stringify({
      events: [{ type: "postback", webhookEventId: "evt-unsupported", timestamp: 1 }],
    });

    const response = await handleRequest(await signedRequest(body), createEnv(sentJobs));

    expect(response.status).toBe(200);
    expect(sentJobs).toHaveLength(0);
  });

  it("群組一般文字不保存，但提及 Bot 時會建立工作", async () => {
    const sentJobs: QueueJob[] = [];
    const baseEvent = {
      type: "message",
      timestamp: 1_785_456_000_000,
      replyToken: "reply-token",
      source: { type: "group", groupId: "C1234567890", userId: "U1234567890abcdef" },
    };
    const body = JSON.stringify({
      events: [
        {
          ...baseEvent,
          webhookEventId: "evt-ignore",
          message: { type: "text", id: "msg-ignore", text: "一般聊天" },
        },
        {
          ...baseEvent,
          webhookEventId: "evt-mention",
          message: {
            type: "text",
            id: "msg-mention",
            text: "@bot 請備份 #重要",
            mention: { mentionees: [{ type: "user", isSelf: true }] },
          },
        },
      ],
    });

    const response = await handleRequest(await signedRequest(body), createEnv(sentJobs));

    expect(response.status).toBe(200);
    expect(sentJobs.map((job) => job.webhookEventId)).toEqual(["evt-mention"]);
  });

  it("群組成員輸入各種備份清單摘要指令都會建立可回覆工作", async () => {
    const sentJobs: QueueJob[] = [];
    const commands = [
      "備份清單",
      "今日備份清單",
      "本週備份清單",
      "8月備份清單",
      "2026年8月備份清單",
      "2026-08 備份清單",
    ];
    const body = JSON.stringify({
      events: commands.map((text, index) => ({
        type: "message",
        webhookEventId: `evt-group-summary-${String(index)}`,
        timestamp: 1_785_456_000_000,
        replyToken: "reply-token",
        source: { type: "group", groupId: "C-summary", userId: "U-member" },
        message: { type: "text", id: `msg-group-summary-${String(index)}`, text },
      })),
    });

    const response = await handleRequest(await signedRequest(body), createEnv(sentJobs));

    expect(response.status).toBe(200);
    expect(sentJobs).toHaveLength(commands.length);
    expect(sentJobs.every((job) => job.command === "groupSummary" && !job.shouldSave)).toBe(true);
  });

  it("群組 #筆記 與附件都會建立工作，附件不含二進位內容", async () => {
    const sentJobs: QueueJob[] = [];
    const baseEvent = {
      type: "message",
      timestamp: 1_785_456_000_000,
      replyToken: "reply-token",
      source: { type: "group", groupId: "C1234567890", userId: "U-member" },
    };
    const body = JSON.stringify({
      events: [
        {
          ...baseEvent,
          webhookEventId: "evt-group-note",
          message: { type: "text", id: "msg-group-note", text: "#筆記 群組測試" },
        },
        {
          ...baseEvent,
          webhookEventId: "evt-group-attachment",
          message: { type: "file", id: "msg-group-attachment", fileName: "測試.pdf", fileSize: 1024 },
        },
      ],
    });

    const response = await handleRequest(await signedRequest(body), createEnv(sentJobs));

    expect(response.status).toBe(200);
    expect(sentJobs).toHaveLength(2);
    expect(sentJobs[0]).toMatchObject({
      command: "note",
      shouldSave: true,
      groupIdHash: await hmacSha256Hex("identifier-secret", "C1234567890"),
      senderDisplayName: "測試使用者",
      groupDisplayName: "測試群組",
    });
    expect(sentJobs[1]).toMatchObject({
      messageType: "file",
      shouldSave: true,
      groupIdHash: await hmacSha256Hex("identifier-secret", "C1234567890"),
      senderDisplayName: "測試使用者",
    });
    expect(JSON.stringify(sentJobs)).not.toContain("C1234567890");
    expect(JSON.stringify(sentJobs)).not.toContain("U-member");
  });

  it("超過設定上限的已知 fileSize 會標記拒絕", async () => {
    const sentJobs: QueueJob[] = [];
    const body = JSON.stringify({
      events: [
        {
          type: "message",
          webhookEventId: "evt-large",
          timestamp: 1_785_456_000_000,
          source: { type: "user", userId: "U1234567890abcdef" },
          message: {
            type: "file",
            id: "msg-large",
            fileName: "large.bin",
            fileSize: 20 * 1024 * 1024 + 1,
          },
        },
      ],
    });

    await handleRequest(await signedRequest(body), createEnv(sentJobs));

    expect(sentJobs[0]).toMatchObject({ shouldSave: false, rejectionCode: "FILE_TOO_LARGE" });
  });

  it("綁定 Token 只含 HMAC lineUserHash，不含原始 LINE userId", async () => {
    const sentJobs: QueueJob[] = [];
    const lineUserId = "U1234567890abcdef";
    const body = JSON.stringify({
      events: [
        {
          type: "message",
          webhookEventId: "evt-bind",
          timestamp: 1_785_456_000_000,
          replyToken: "reply-token",
          source: { type: "user", userId: lineUserId },
          message: { type: "text", id: "msg-bind", text: "綁定 TEST-CODE" },
        },
      ],
    });

    await handleRequest(await signedRequest(body), createEnv(sentJobs));

    const bindToken = sentJobs[0]?.bindToken;
    expect(bindToken).not.toBeNull();
    const payload = await verifyBindToken(
      bindToken ?? "",
      "bind-secret",
      Date.now(),
    );
    expect(payload?.lineUserHash).toBe(await hmacSha256Hex("identifier-secret", lineUserId));
    expect(JSON.stringify(payload)).not.toContain(lineUserId);
    expect(bindToken).not.toContain(lineUserId);
  });

  it("LINE Profile API 失敗時仍排入備份工作並使用安全化名稱", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("profile unavailable")));
    const sentJobs: QueueJob[] = [];
    const body = JSON.stringify({
      events: [{
        type: "message",
        webhookEventId: "evt-profile-failure",
        timestamp: 1_785_456_000_000,
        source: { type: "user", userId: "U-profile-failure" },
        message: { type: "text", id: "msg-profile-failure", text: "測試備份" },
      }],
    });

    const response = await handleRequest(await signedRequest(body), createEnv(sentJobs));

    expect(response.status).toBe(200);
    expect(sentJobs[0]?.senderDisplayName).toMatch(/^user_[a-f0-9]{8}$/u);
  });

  it("沒有邀請碼的綁定仍會產生短效 OAuth Bind Token", async () => {
    const sentJobs: QueueJob[] = [];
    const body = JSON.stringify({
      events: [{
        type: "message",
        webhookEventId: "evt-self-service-bind",
        timestamp: 1_785_456_000_000,
        replyToken: "reply-token",
        source: { type: "user", userId: "U-self-service" },
        message: { type: "text", id: "msg-self-service-bind", text: "綁定" },
      }],
    });

    await handleRequest(await signedRequest(body), createEnv(sentJobs));

    expect(sentJobs[0]?.command).toBe("bind");
    expect(sentJobs[0]?.bindToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    expect(sentJobs[0]?.bindToken).not.toContain("U-self-service");
  });

  it("重新授權會產生只含 lineUserHash 的短效 OAuth Bind Token", async () => {
    const sentJobs: QueueJob[] = [];
    const body = JSON.stringify({
      events: [{
        type: "message",
        webhookEventId: "evt-reauthorize",
        timestamp: 1_785_456_000_000,
        replyToken: "reply-token",
        source: { type: "user", userId: "U-reauthorize" },
        message: { type: "text", id: "msg-reauthorize", text: "重新授權" },
      }],
    });

    await handleRequest(await signedRequest(body), createEnv(sentJobs));

    expect(sentJobs[0]?.command).toBe("reauthorize");
    expect(sentJobs[0]?.bindToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    expect(sentJobs[0]?.bindToken).not.toContain("U-reauthorize");
  });

  it("Bind Token 金鑰輪替不改變識別雜湊，識別金鑰輪替才會改變", async () => {
    const lineUserId = "U1234567890abcdef";
    const body = JSON.stringify({
      events: [
        {
          type: "message",
          webhookEventId: "evt-bind-rotation",
          timestamp: 1_785_456_000_000,
          replyToken: "reply-token",
          source: { type: "user", userId: lineUserId },
          message: { type: "text", id: "msg-bind-rotation", text: "綁定 TEST-CODE" },
        },
      ],
    });
    const originalJobs: QueueJob[] = [];
    const rotatedBindJobs: QueueJob[] = [];
    const rotatedIdentifierJobs: QueueJob[] = [];

    await handleRequest(
      await signedRequest(body),
      createEnv(originalJobs, "bind-secret-a", "identifier-secret-a"),
    );
    await handleRequest(
      await signedRequest(body),
      createEnv(rotatedBindJobs, "bind-secret-b", "identifier-secret-a"),
    );
    await handleRequest(
      await signedRequest(body),
      createEnv(rotatedIdentifierJobs, "bind-secret-a", "identifier-secret-b"),
    );

    const originalPayload = await verifyBindToken(
      originalJobs[0]?.bindToken ?? "",
      "bind-secret-a",
      Date.now(),
    );
    const rotatedBindPayload = await verifyBindToken(
      rotatedBindJobs[0]?.bindToken ?? "",
      "bind-secret-b",
      Date.now(),
    );
    const rotatedIdentifierPayload = await verifyBindToken(
      rotatedIdentifierJobs[0]?.bindToken ?? "",
      "bind-secret-a",
      Date.now(),
    );

    expect(rotatedBindPayload?.lineUserHash).toBe(originalPayload?.lineUserHash);
    expect(rotatedIdentifierPayload?.lineUserHash).not.toBe(originalPayload?.lineUserHash);
  });
});
