import { ExternalApiError } from "./gas-client";
import { fetchWithTimeout } from "./http";

const LINE_API_TIMEOUT_MILLISECONDS = 5000;

const DISPLAY_NAME_MAX_LENGTH = 100;

function sanitizeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 0x1f && codePoint !== 0x7f;
    })
    .join("")
    .trim()
    .slice(0, DISPLAY_NAME_MAX_LENGTH);
  if (normalized.length === 0) {
    return null;
  }
  // 讓後續 Sheets RAW 寫入不會被試算表視為公式。
  return /^[=+\-@]/u.test(normalized) ? `'${normalized}` : normalized;
}

async function fetchDisplayName(
  channelAccessToken: string,
  endpoint: string,
  fieldName = "displayName",
): Promise<string | null> {
  try {
    const response = await fetchWithTimeout(
      endpoint,
      {
        method: "GET",
        headers: { authorization: `Bearer ${channelAccessToken}` },
      },
      LINE_API_TIMEOUT_MILLISECONDS,
    );
    if (!response.ok) {
      return null;
    }
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || !(fieldName in value)) {
      return null;
    }
    return sanitizeDisplayName((value as Record<string, unknown>)[fieldName]);
  } catch {
    // 顯示名稱是輔助欄位，LINE Profile 失敗不得中斷備份。
    return null;
  }
}

export function fallbackDisplayName(lineUserHash: string | null): string {
  if (typeof lineUserHash === "string" && /^[a-f0-9]{64}$/u.test(lineUserHash)) {
    return `user_${lineUserHash.slice(0, 8)}`;
  }
  return "unknown_user";
}

export async function getPrivateDisplayName(
  channelAccessToken: string,
  lineUserId: string,
): Promise<string | null> {
  return fetchDisplayName(
    channelAccessToken,
    `https://api.line.me/v2/bot/profile/${encodeURIComponent(lineUserId)}`,
  );
}

export async function getGroupMemberDisplayName(
  channelAccessToken: string,
  groupId: string,
  lineUserId: string,
): Promise<string | null> {
  return fetchDisplayName(
    channelAccessToken,
    `https://api.line.me/v2/bot/group/${encodeURIComponent(groupId)}/member/${encodeURIComponent(lineUserId)}`,
  );
}

export async function getGroupDisplayName(
  channelAccessToken: string,
  groupId: string,
): Promise<string | null> {
  return fetchDisplayName(
    channelAccessToken,
    `https://api.line.me/v2/bot/group/${encodeURIComponent(groupId)}/summary`,
    "groupName",
  );
}

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
