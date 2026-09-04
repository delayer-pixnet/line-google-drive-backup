import {
  computeWorkerEnvelopeSignature,
  constantTimeEqual,
  verifyLineSignature,
} from "./crypto";
import { ExternalApiError, callGas } from "./gas-client";
import { jsonResponse } from "./http";
import {
  isInvalidReplyTokenError,
  replyTextMessage,
} from "./line-client";
import { safeLog } from "./logger";
import type { Env, HmacDiagnostic, QueueJob } from "./types";
import { parseBooleanFlag, parsePositiveInteger, requireNonEmpty } from "./validation";
import { parseWebhookBody } from "./webhook";
import { isRecord } from "./validation";

const DEFAULT_MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;
const REPLAY_ENVELOPE_MAX_AGE_MS = 5 * 60 * 1000;
const REPLAY_PAYLOAD_MAX_LENGTH = 120_000;
const REPLAY_NONCE_PATTERN = /^[a-f0-9]{32}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const EVENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

type RecentGasHealth = {
  readonly status: "ok" | "failed" | "unknown";
  readonly httpStatus?: number;
  readonly errorCode?: string;
  readonly checkedAt?: number;
};

// Worker isolate 內的輕量狀態僅供即時診斷；重啟後會回到 unknown，不保存敏感資料。
let recentGasHealth: RecentGasHealth = { status: "unknown" };

const GAS_AUTHORIZATION_FALLBACK_MESSAGE =
  "系統暫時無法回應，可能是 Apps Script 需要管理者重新授權。\n" +
  "管理者請執行 testOwnerAuthorizationHealth，完成 Google 授權後再重試。";

function normalizeSafeErrorCode(value: string | undefined): string | undefined {
  if (value === undefined || !/^[A-Za-z0-9_:-]{1,60}$/u.test(value)) {
    return undefined;
  }
  return value;
}

function formatTaipeiTime(milliseconds: number): string {
  const taipei = new Date(milliseconds + 8 * 60 * 60 * 1000);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${String(taipei.getUTCFullYear())}/${pad(taipei.getUTCMonth() + 1)}/${pad(taipei.getUTCDate())} ${pad(taipei.getUTCHours())}:${pad(taipei.getUTCMinutes())}`;
}

function updateRecentGasHealth(value: RecentGasHealth): void {
  const safeErrorCode = normalizeSafeErrorCode(value.errorCode);
  recentGasHealth = {
    status: value.status,
    ...(value.httpStatus === undefined ? {} : { httpStatus: value.httpStatus }),
    ...(safeErrorCode === undefined ? {} : { errorCode: safeErrorCode }),
    checkedAt: Date.now(),
  };
}

function formatSystemStatusMessage(includeErrorCode = false): string {
  const health = recentGasHealth;
  const lines = [
    "系統狀態：",
    "Worker：正常",
    "Queue：已設定",
    `最近 GAS 呼叫狀態：${health.status === "ok" ? "正常" : health.status === "failed" ? "失敗" : "未知"}`,
  ];
  if (health.httpStatus !== undefined) {
    lines.push(`最近 GAS HTTP 狀態碼：${String(health.httpStatus)}`);
  }
  if (includeErrorCode && health.errorCode !== undefined) {
    lines.push(`最近 GAS 錯誤代碼：${health.errorCode}`);
  }
  if (health.checkedAt !== undefined) {
    lines.push(`最近檢查時間：${formatTaipeiTime(health.checkedAt)}`);
  }
  if (health.status === "failed") {
    lines.push("可能原因：Apps Script 暫時無法回應或需要管理者授權。", "建議：管理者執行 testOwnerAuthorizationHealth。");
  } else {
    lines.push("建議：若 LINE 沒有回應，請管理者檢查 Cloudflare tail 與 Apps Script 執行記錄。");
  }
  return lines.join("\n");
}

function shouldSendGasAuthorizationFallback(error: ExternalApiError): boolean {
  if (error.errorCode !== "GAS_HTTP_ERROR") {
    return false;
  }
  const contentType = error.contentType ?? "";
  const isHtml = contentType.includes("text/html");
  const hasNoJsonError = error.upstreamErrorCode === undefined &&
    (contentType.length === 0 || !contentType.includes("application/json"));
  return (error.httpStatus === 403 && isHtml) || hasNoJsonError;
}

async function sendGasAuthorizationFallback(
  message: Message<QueueJob>,
  env: Env,
  correlationId: string,
): Promise<void> {
  if (message.body.replyToken === null) {
    return;
  }
  try {
    await replyTextMessage(
      requireNonEmpty(env.LINE_CHANNEL_ACCESS_TOKEN, "LINE_CHANNEL_ACCESS_TOKEN"),
      message.body.replyToken,
      GAS_AUTHORIZATION_FALLBACK_MESSAGE,
    );
    safeLog("info", {
      component: "line",
      status: "acknowledged",
      errorCode: "GAS_AUTHORIZATION_FALLBACK_REPLIED",
      correlationId,
    });
  } catch (error: unknown) {
    safeLog("warn", {
      component: "line",
      status: "failed",
      errorCode: isInvalidReplyTokenError(error)
        ? "LINE_REPLY_TOKEN_INVALID"
        : error instanceof ExternalApiError ? error.errorCode : "LINE_REPLY_FAILED",
      correlationId,
    });
  }
}

function isSafeDisplayName(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 200) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.charCodeAt(0);
    if (codePoint < 32 || codePoint === 127) {
      return false;
    }
  }
  return true;
}

function isReplayQueueJob(value: unknown): value is QueueJob {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.eventType !== "message") {
    return false;
  }
  if (typeof value.webhookEventId !== "string" || !EVENT_ID_PATTERN.test(value.webhookEventId)) {
    return false;
  }
  if (typeof value.messageId !== "string" || !MESSAGE_ID_PATTERN.test(value.messageId)) {
    return false;
  }
  if (value.messageType !== "text" && value.messageType !== "image" &&
      value.messageType !== "video" && value.messageType !== "audio" &&
      value.messageType !== "file") {
    return false;
  }
  if (typeof value.lineUserHash !== "string" || !HASH_PATTERN.test(value.lineUserHash)) {
    return false;
  }
  if (value.groupIdHash !== null &&
      (typeof value.groupIdHash !== "string" || !HASH_PATTERN.test(value.groupIdHash))) {
    return false;
  }
  if (value.replyToken !== null || value.bindToken !== null || value.rejectionCode !== null) {
    return false;
  }
  const messageTimestamp = value.timestamp;
  if (typeof messageTimestamp !== "number" || !Number.isSafeInteger(messageTimestamp) || messageTimestamp < 0 || messageTimestamp > Date.now() + REPLAY_ENVELOPE_MAX_AGE_MS) {
    return false;
  }
  if (value.rawText !== null && (typeof value.rawText !== "string" || value.rawText.length > 5000)) {
    return false;
  }
  if (value.fileName !== null && (typeof value.fileName !== "string" || value.fileName.length > 255)) {
    return false;
  }
  if (value.senderDisplayName !== null && !isSafeDisplayName(value.senderDisplayName)) {
    return false;
  }
  if (value.groupDisplayName !== null && !isSafeDisplayName(value.groupDisplayName)) {
    return false;
  }
  if (value.fileSize !== null &&
      (typeof value.fileSize !== "number" || !Number.isSafeInteger(value.fileSize) || value.fileSize < 0)) {
    return false;
  }
  return value.shouldSave === true && (value.command === null || value.command === "note");
}

async function handleReplay(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  if (rawBody.length === 0 || rawBody.length > REPLAY_PAYLOAD_MAX_LENGTH + 2_000) {
    safeLog("warn", { component: "replay", status: "rejected", errorCode: "REPLAY_REQUEST_INVALID" });
    return jsonResponse({ message: "請求格式不正確。" }, 400);
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    safeLog("warn", { component: "replay", status: "rejected", errorCode: "REPLAY_REQUEST_INVALID" });
    return jsonResponse({ message: "請求格式不正確。" }, 400);
  }
  const timestamp = isRecord(envelope) ? envelope.timestamp : undefined;
  const nonce = isRecord(envelope) ? envelope.nonce : undefined;
  const payload = isRecord(envelope) ? envelope.payload : undefined;
  const signature = isRecord(envelope) ? envelope.signature : undefined;
  if (typeof timestamp !== "number" ||
      !Number.isSafeInteger(timestamp) ||
      Math.abs(Date.now() - timestamp) > REPLAY_ENVELOPE_MAX_AGE_MS ||
      typeof nonce !== "string" || !REPLAY_NONCE_PATTERN.test(nonce) ||
      typeof payload !== "string" || payload.length === 0 || payload.length > REPLAY_PAYLOAD_MAX_LENGTH ||
      typeof signature !== "string" || !/^[a-f0-9]{64}$/u.test(signature)) {
    safeLog("warn", { component: "replay", status: "rejected", errorCode: "REPLAY_ENVELOPE_INVALID" });
    return jsonResponse({ message: "請求驗證失敗。" }, 401);
  }
  let expectedSignature: string;
  try {
    expectedSignature = await computeWorkerEnvelopeSignature(
      timestamp,
      nonce,
      payload,
      requireNonEmpty(env.WORKER_GAS_SHARED_SECRET, "WORKER_GAS_SHARED_SECRET"),
    );
  } catch {
    safeLog("error", { component: "replay", status: "failed", errorCode: "REPLAY_CONFIG_INVALID" });
    return jsonResponse({ message: "服務設定不完整。" }, 500);
  }
  if (!constantTimeEqual(expectedSignature, signature)) {
    safeLog("warn", { component: "replay", status: "rejected", errorCode: "REPLAY_SIGNATURE_INVALID" });
    return jsonResponse({ message: "請求驗證失敗。" }, 401);
  }
  let replayPayload: unknown;
  try {
    replayPayload = JSON.parse(payload);
  } catch {
    safeLog("warn", { component: "replay", status: "rejected", errorCode: "REPLAY_PAYLOAD_INVALID" });
    return jsonResponse({ message: "請求內容不正確。" }, 400);
  }
  if (!isRecord(replayPayload) || !Array.isArray(replayPayload.jobs) ||
      replayPayload.jobs.length === 0 || replayPayload.jobs.length > 100 ||
      !replayPayload.jobs.every(isReplayQueueJob)) {
    safeLog("warn", { component: "replay", status: "rejected", errorCode: "REPLAY_JOBS_INVALID" });
    return jsonResponse({ message: "補備份工作格式不正確。" }, 400);
  }
  try {
    await Promise.all(replayPayload.jobs.map((job) => env.BACKUP_QUEUE.send(job, { contentType: "json" })));
  } catch {
    safeLog("error", { component: "replay", status: "failed", errorCode: "REPLAY_QUEUE_SEND_FAILED" });
    return jsonResponse({ message: "暫時無法建立補備份任務。" }, 503);
  }
  safeLog("info", {
    component: "replay",
    status: "accepted",
    count: replayPayload.jobs.length,
  });
  return jsonResponse({ ok: true, acceptedCount: replayPayload.jobs.length });
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > 1024 * 1024) {
    return jsonResponse({ message: "請求內容過大。" }, 413);
  }
  const rawBody = await request.text();
  if (rawBody.length === 0) {
    return jsonResponse({ message: "Webhook 內容不可為空。" }, 400);
  }
  const providedSignature = request.headers.get("x-line-signature");
  if (
    providedSignature === null ||
    !(await verifyLineSignature(
      rawBody,
      providedSignature,
      requireNonEmpty(env.LINE_CHANNEL_SECRET, "LINE_CHANNEL_SECRET"),
    ))
  ) {
    safeLog("warn", { component: "webhook", status: "failed", errorCode: "INVALID_SIGNATURE" });
    return jsonResponse({ message: "簽章驗證失敗。" }, 401);
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ message: "Webhook JSON 格式不正確。" }, 400);
  }

  let jobs: QueueJob[];
  try {
    jobs = await parseWebhookBody(
      parsedBody,
      requireNonEmpty(env.LINE_CHANNEL_ACCESS_TOKEN, "LINE_CHANNEL_ACCESS_TOKEN"),
      requireNonEmpty(env.IDENTIFIER_HASH_SECRET, "IDENTIFIER_HASH_SECRET"),
      requireNonEmpty(env.BIND_TOKEN_SECRET, "BIND_TOKEN_SECRET"),
      parsePositiveInteger(env.BIND_TOKEN_TTL_SECONDS, 600, 3600),
      parsePositiveInteger(
        env.MAX_FILE_SIZE_BYTES,
        DEFAULT_MAX_FILE_SIZE_BYTES,
        49 * 1024 * 1024,
      ),
    );
  } catch {
    return jsonResponse({ message: "Webhook 內容格式不正確。" }, 400);
  }

  try {
    await Promise.all(jobs.map((job) => env.BACKUP_QUEUE.send(job, { contentType: "json" })));
  } catch {
    safeLog("error", { component: "webhook", status: "failed", errorCode: "QUEUE_SEND_FAILED" });
    return jsonResponse({ message: "暫時無法接收訊息，請稍後重試。" }, 503);
  }
  safeLog("info", { component: "webhook", status: "accepted" });
  return jsonResponse({ ok: true });
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return jsonResponse({ status: "ok" });
  }
  if (request.method === "POST" && url.pathname === "/webhook") {
    return handleWebhook(request, env);
  }
  if (request.method === "POST" && url.pathname === "/internal/replay") {
    return handleReplay(request, env);
  }
  return jsonResponse({ message: "找不到指定端點。" }, 404);
}

export async function processQueueMessage(
  message: Message<QueueJob>,
  env: Env,
): Promise<void> {
  const correlationId = message.body.webhookEventId;
  // 系統診斷指令不依賴 GAS；仍透過 Queue 保持 Webhook 快速回應與既有重試模型。
  if (message.body.command === "systemStatus" && message.body.groupIdHash === null) {
    if (message.body.replyToken !== null) {
      try {
        await replyTextMessage(
          requireNonEmpty(env.LINE_CHANNEL_ACCESS_TOKEN, "LINE_CHANNEL_ACCESS_TOKEN"),
          message.body.replyToken,
          formatSystemStatusMessage(message.body.rawText === "系統診斷"),
        );
      } catch (error: unknown) {
        safeLog("warn", {
          component: "line",
          status: "failed",
          correlationId,
          errorCode: isInvalidReplyTokenError(error)
            ? "LINE_REPLY_TOKEN_INVALID"
            : error instanceof ExternalApiError ? error.errorCode : "LINE_REPLY_FAILED",
        });
      }
    }
    message.ack();
    safeLog("info", { component: "system", status: "acknowledged", correlationId });
    return;
  }
  try {
    const gasResult = await callGas(
      requireNonEmpty(env.GAS_ENDPOINT_URL, "GAS_ENDPOINT_URL"),
      requireNonEmpty(env.WORKER_GAS_SHARED_SECRET, "WORKER_GAS_SHARED_SECRET"),
      message.body,
      parsePositiveInteger(env.GAS_REQUEST_TIMEOUT_MS, 55_000, 60_000),
      parseBooleanFlag(env.HMAC_DIAGNOSTIC_ENABLED, false),
    );
    updateRecentGasHealth(
      gasResult.ok
        ? { status: "ok" }
        : {
            status: "failed",
            ...(gasResult.errorCode === undefined ? {} : { errorCode: gasResult.errorCode }),
          },
    );
    const hmacDiagnostic: HmacDiagnostic | undefined =
      parseBooleanFlag(env.HMAC_DIAGNOSTIC_ENABLED, false) &&
      (gasResult.workerDiagnostic !== undefined || gasResult.diagnostic !== undefined)
        ? { ...gasResult.workerDiagnostic, ...gasResult.diagnostic }
        : undefined;
    if (!gasResult.ok) {
      const isRetryable = gasResult.retryable === true;
      const gasStatus: "retrying" | "rejected" = isRetryable ? "retrying" : "rejected";
      const gasLogEntry = {
        component: "gas" as const,
        status: gasStatus,
        correlationId,
        errorCode: gasResult.errorCode ?? "GAS_REJECTED",
      };
      safeLog(
        isRetryable && gasResult.errorCode === "JOB_IN_PROGRESS" ? "info" : "warn",
        hmacDiagnostic === undefined
          ? gasLogEntry
          : { ...gasLogEntry, diagnostic: hmacDiagnostic },
      );
      if (isRetryable) {
        message.retry({ delaySeconds: gasResult.retryAfterSeconds ?? 60 });
        return;
      }
    } else if (hmacDiagnostic !== undefined) {
      safeLog("info", {
        component: "gas",
        status: "diagnostic",
        correlationId,
        diagnostic: hmacDiagnostic,
      });
    }
    const isBackupSuccessReply = gasResult.backupSuccessReply === true;
    const isGroupBackupAttachment =
      isBackupSuccessReply &&
      message.body.groupIdHash !== null &&
      message.body.command !== "note";
    const shouldSendReply =
      gasResult.replyMessage !== undefined &&
      message.body.replyToken !== null &&
      !isGroupBackupAttachment &&
      (!isBackupSuccessReply || parseBooleanFlag(env.ENABLE_BACKUP_SUCCESS_REPLY, true));
    if (shouldSendReply) {
      try {
        await replyTextMessage(
          requireNonEmpty(env.LINE_CHANNEL_ACCESS_TOKEN, "LINE_CHANNEL_ACCESS_TOKEN"),
          message.body.replyToken,
          gasResult.replyMessage,
        );
      } catch (error: unknown) {
        // Reply Token 短效且只能使用一次，不因回覆失敗重做已完成的備份。
        safeLog("warn", {
          component: "line",
          status: "failed",
          correlationId,
          errorCode: error instanceof ExternalApiError
            ? error.errorCode
            : "LINE_REPLY_FAILED",
        });
        // Queue metadata 不保存 raw userId／groupId，本流程只使用 Reply API。
      }
    }
    message.ack();
    safeLog("info", { component: "queue", status: "acknowledged", correlationId });
  } catch (error: unknown) {
    const externalError = error instanceof ExternalApiError ? error : null;
    if (externalError?.errorCode === "GAS_HTTP_ERROR") {
      updateRecentGasHealth({
        status: "failed",
        ...(externalError.httpStatus === undefined ? {} : { httpStatus: externalError.httpStatus }),
        errorCode: externalError.upstreamErrorCode ?? externalError.errorCode,
      });
    }
    if (externalError?.errorCode === "GAS_HTTP_ERROR") {
      safeLog(externalError.retryable ? "warn" : "error", {
        component: "gas",
        status: "http_error",
        correlationId,
        errorCode: "GAS_HTTP_ERROR",
        ...(externalError.httpStatus === undefined ? {} : { httpStatus: externalError.httpStatus }),
        ...(externalError.contentType === undefined ? {} : { contentType: externalError.contentType }),
        ...(externalError.redirected === undefined ? {} : { redirected: externalError.redirected }),
        ...(externalError.upstreamErrorCode === undefined
          ? {}
          : { upstreamErrorCode: externalError.upstreamErrorCode }),
        ...(externalError.diagnostic === undefined ? {} : { diagnostic: externalError.diagnostic }),
      });
      if (shouldSendGasAuthorizationFallback(externalError)) {
        await sendGasAuthorizationFallback(message, env, correlationId);
      }
    }
    safeLog(externalError?.retryable === true ? "warn" : "error", {
      component: "queue",
      status: externalError?.retryable === true ? "retrying" : "failed",
      correlationId,
      errorCode: externalError?.errorCode ?? "QUEUE_PROCESSING_FAILED",
    });
    if (externalError?.retryable === true) {
      message.retry({ delaySeconds: 60 });
    } else {
      message.ack();
    }
  }
}

const worker: ExportedHandler<Env, QueueJob> = {
  fetch: handleRequest,
  async queue(batch, env): Promise<void> {
    await Promise.all(batch.messages.map((message) => processQueueMessage(message, env)));
  },
};

export default worker;
