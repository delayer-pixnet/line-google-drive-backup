import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fallbackDisplayName,
  getGroupDisplayName,
  getGroupMemberDisplayName,
  getPrivateDisplayName,
  pushTextMessage,
  replyTextMessage,
} from "../src/line-client";

describe("LINE Reply client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("以 Reply API 成功回覆文字", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(replyTextMessage("channel-token", "reply-token", "備份完成。"))
      .resolves.toBeUndefined();
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(requestInit.headers).get("authorization")).toBe("Bearer channel-token");
    expect(typeof requestInit.body).toBe("string");
    expect(JSON.parse(typeof requestInit.body === "string" ? requestInit.body : "")).toEqual({
      replyToken: "reply-token",
      messages: [{ type: "text", text: "備份完成。" }],
    });
  });

  it("LINE 回覆失敗時回傳安全錯誤模型", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      Response.json({ message: "Invalid reply token" }, { status: 400 }),
    ));

    await expect(replyTextMessage("channel-token", "expired-reply-token", "備份完成。"))
      .rejects.toMatchObject({
        errorCode: "LINE_REPLY_TOKEN_INVALID",
        retryable: false,
      });
  });

  it("一般 400 或 Channel Token 401 不誤判為 Reply Token 失效", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ message: "Bad request" }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ message: "Authentication failed" }, { status: 401 })));

    await expect(replyTextMessage("channel-token", "reply-token", "備份完成。"))
      .rejects.toMatchObject({ errorCode: "LINE_REPLY_FAILED", retryable: false });
    await expect(replyTextMessage("invalid-channel-token", "reply-token", "備份完成。"))
      .rejects.toMatchObject({ errorCode: "LINE_REPLY_FAILED", retryable: false });
  });

  it("以 Push API 成功傳送文字", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(pushTextMessage("channel-token", "U-recipient", "綁定完成。"))
      .resolves.toBeUndefined();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/message/push");
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(typeof requestInit.body === "string" ? requestInit.body : "")).toEqual({
      to: "U-recipient",
      messages: [{ type: "text", text: "綁定完成。" }],
    });
  });

  it("LINE Push 失敗時回傳安全錯誤模型", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));

    await expect(pushTextMessage("channel-token", "U-recipient", "綁定完成。"))
      .rejects.toMatchObject({
        errorCode: "LINE_PUSH_FAILED",
        retryable: true,
      });
  });

  it("可取得私訊與群組成員／群組顯示名稱，並清理公式前綴", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ displayName: "=危險名稱" }))
      .mockResolvedValueOnce(Response.json({ displayName: "群組成員" }))
      .mockResolvedValueOnce(Response.json({ groupName: "測試群組" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getPrivateDisplayName("channel-token", "U-private"))
      .resolves.toBe("'=危險名稱");
    await expect(getGroupMemberDisplayName("channel-token", "C-group", "U-member"))
      .resolves.toBe("群組成員");
    await expect(getGroupDisplayName("channel-token", "C-group"))
      .resolves.toBe("測試群組");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v2/bot/profile/U-private");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/member/U-member");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("/summary");
  });

  it("顯示名稱 API 失敗時回傳安全 fallback", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("failed", { status: 403 })));

    await expect(getPrivateDisplayName("channel-token", "U-private")).resolves.toBeNull();
    expect(fallbackDisplayName("a".repeat(64))).toBe("user_aaaaaaaa");
    expect(fallbackDisplayName(null)).toBe("unknown_user");
  });
});
