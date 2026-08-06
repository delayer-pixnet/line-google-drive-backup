import type { HmacDiagnostic } from "./types";

export interface SafeLogEntry {
  readonly component: "webhook" | "queue" | "gas" | "line";
  readonly status:
    | "accepted"
    | "ignored"
    | "completed"
    | "acknowledged"
    | "rejected"
    | "diagnostic"
    | "http_error"
    | "failed"
    | "retrying";
  readonly correlationId?: string;
  readonly errorCode?: string;
  readonly upstreamErrorCode?: string;
  readonly httpStatus?: number;
  readonly contentType?: string;
  readonly redirected?: boolean;
  readonly diagnostic?: HmacDiagnostic;
}

const SHORT_HEX_PATTERN = /^[a-f0-9]{16}$/u;
const SCRIPT_SUFFIX_PATTERN = /^[A-Za-z0-9_-]{8}$/u;
const SAFE_ERROR_CODE_PATTERN = /^[A-Za-z0-9_:-]{1,60}$/u;
const SAFE_CONTENT_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;

function sanitizeDiagnostic(diagnostic: HmacDiagnostic | undefined): Record<string, string> | undefined {
  if (diagnostic === undefined) {
    return undefined;
  }
  const sanitized: Record<string, string> = {};
  const hexFields: Array<keyof HmacDiagnostic> = [
    "workerSecretFingerprint",
    "workerSigningInputFingerprint",
    "workerSignaturePrefix",
    "gasSecretFingerprint",
    "gasSigningInputFingerprint",
    "gasExpectedSignaturePrefix",
    "gasProvidedSignaturePrefix",
  ];
  for (const field of hexFields) {
    const value = diagnostic[field];
    if (typeof value === "string" && SHORT_HEX_PATTERN.test(value)) {
      sanitized[field] = value;
    }
  }
  if (
    typeof diagnostic.gasScriptIdSuffix === "string" &&
    SCRIPT_SUFFIX_PATTERN.test(diagnostic.gasScriptIdSuffix)
  ) {
    sanitized.gasScriptIdSuffix = diagnostic.gasScriptIdSuffix;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function safeLog(
  level: "info" | "warn" | "error",
  entry: SafeLogEntry,
): void {
  // 僅輸出白名單欄位，避免呼叫端誤把 Token、Secret 或訊息內容寫入 Log。
  const safeDiagnostic = sanitizeDiagnostic(entry.diagnostic);
  const serialized = JSON.stringify({
    component: entry.component,
    status: entry.status,
    ...(entry.correlationId === undefined
      ? {}
      : { correlationId: entry.correlationId.slice(0, 100) }),
    ...(entry.errorCode === undefined ? {} : { errorCode: entry.errorCode.slice(0, 60) }),
    ...(entry.upstreamErrorCode !== undefined && SAFE_ERROR_CODE_PATTERN.test(entry.upstreamErrorCode)
      ? { upstreamErrorCode: entry.upstreamErrorCode }
      : {}),
    ...(typeof entry.httpStatus === "number" && Number.isSafeInteger(entry.httpStatus) && entry.httpStatus >= 100 && entry.httpStatus <= 599
      ? { httpStatus: entry.httpStatus }
      : {}),
    ...(entry.contentType !== undefined && SAFE_CONTENT_TYPE_PATTERN.test(entry.contentType)
      ? { contentType: entry.contentType }
      : {}),
    ...(entry.redirected === undefined ? {} : { redirected: entry.redirected }),
    ...(safeDiagnostic === undefined ? {} : { diagnostic: safeDiagnostic }),
  });
  if (level === "error") {
    console.error(serialized);
  } else if (level === "warn") {
    console.warn(serialized);
  } else {
    console.info(serialized);
  }
}
