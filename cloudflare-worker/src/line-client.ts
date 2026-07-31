import { ExternalApiError } from "./gas-client";
import { fetchWithTimeout } from "./http";

const LINE_API_TIMEOUT_MILLISECONDS = 5000;

async function isExplicitInvalidReplyTokenResponse(response: Response): Promise<boolean> {
  if (response.status !== 400) {
    return false;
  }
  try {
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || !("message" in value)) {
      return false;
    }
    const message = value.message;
    return typeof message === "string" && /reply\s+token/iu.test(message) &&
      /(invalid|expired|already\s+used)/iu.test(message);
  } catch {
    return false;
  }
}

export async function replyTextMessage(
  channelAccessToken: string,
  replyToken: string,
  text: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      "https://api.line.me/v2/bot/message/reply",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${channelAccessToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          replyToken,
          messages: [{ type: "text", text: text.slice(0, 5000) }],
        }),
      },
      LINE_API_TIMEOUT_MILLISECONDS,
    );
  } catch {
    throw new ExternalApiError("LINE_REPLY_NETWORK_ERROR", true);
  }
  if (!response.ok) {
    const errorCode = await isExplicitInvalidReplyTokenResponse(response)
      ? "LINE_REPLY_TOKEN_INVALID"
      : "LINE_REPLY_FAILED";
    throw new ExternalApiError(errorCode, response.status >= 500);
  }
}

export async function pushTextMessage(
  channelAccessToken: string,
  recipientId: string,
  text: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      "https://api.line.me/v2/bot/message/push",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${channelAccessToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          to: recipientId,
          messages: [{ type: "text", text: text.slice(0, 5000) }],
        }),
      },
      LINE_API_TIMEOUT_MILLISECONDS,
    );
  } catch {
    throw new ExternalApiError("LINE_PUSH_NETWORK_ERROR", true);
  }
  if (!response.ok) {
    throw new ExternalApiError("LINE_PUSH_FAILED", response.status >= 500);
  }
}

export function isInvalidReplyTokenError(error: unknown): boolean {
  return error instanceof ExternalApiError && error.errorCode === "LINE_REPLY_TOKEN_INVALID";
}
