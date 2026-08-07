import { verifyLineSignature } from "./crypto";
import { ExternalApiError, callGas } from "./gas-client";
import { jsonResponse } from "./http";
import {
  isInvalidReplyTokenError,
  pushTextMessage,
  replyTextMessage,
} from "./line-client";
import { safeLog } from "./logger";
import type { Env, HmacDiagnostic, QueueJob } from "./types";
import { parseBooleanFlag, parsePositiveInteger, requireNonEmpty } from "./validation";
import { parseWebhookBody } from "./webhook";

const DEFAULT_MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

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
  return jsonResponse({ message: "找不到指定端點。" }, 404);
}

export async function processQueueMessage(
  message: Message<QueueJob>,
  env: Env,
): Promise<void> {
  const correlationId = message.body.webhookEventId;
  try {
    const gasResult = await callGas(
      requireNonEmpty(env.GAS_ENDPOINT_URL, "GAS_ENDPOINT_URL"),
      requireNonEmpty(env.WORKER_GAS_SHARED_SECRET, "WORKER_GAS_SHARED_SECRET"),
      message.body,
      parsePositiveInteger(env.GAS_REQUEST_TIMEOUT_MS, 55_000, 60_000),
      parseBooleanFlag(env.HMAC_DIAGNOSTIC_ENABLED, false),
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
      message.body.groupId !== null &&
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
        const pushRecipient = message.body.groupId ?? message.body.lineUserId;
        if (
          isInvalidReplyTokenError(error) &&
          !isBackupSuccessReply &&
          parseBooleanFlag(env.ENABLE_PUSH_FALLBACK, false) &&
          pushRecipient !== null
        ) {
          try {
            await pushTextMessage(
              requireNonEmpty(
                env.LINE_CHANNEL_ACCESS_TOKEN,
                "LINE_CHANNEL_ACCESS_TOKEN",
              ),
              pushRecipient,
              gasResult.replyMessage,
            );
            safeLog("info", {
              component: "line",
              status: "completed",
              correlationId,
            });
          } catch (pushError: unknown) {
            safeLog("warn", {
              component: "line",
              status: "failed",
              correlationId,
              errorCode: pushError instanceof ExternalApiError
                ? pushError.errorCode
                : "LINE_PUSH_FAILED",
            });
          }
        }
      }
    }
    message.ack();
    safeLog("info", { component: "queue", status: "acknowledged", correlationId });
  } catch (error: unknown) {
    const externalError = error instanceof ExternalApiError ? error : null;
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
