import { afterEach, describe, expect, it, vi } from "vitest";
import { pushTextMessage, replyTextMessage } from "../src/line-client";

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
});
