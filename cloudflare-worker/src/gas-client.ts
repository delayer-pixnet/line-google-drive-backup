import {
  computeWorkerEnvelopeSignature,
  createNonce,
  hmacSha256Hex,
  sha256Hex,
} from "./crypto";
import { fetchWithTimeout } from "./http";
import type { GasResult, HmacDiagnostic, QueueJob } from "./types";
import { isRecord } from "./validation";

const HMAC_DIAGNOSTIC_PUBLIC_KEY = "line-backup-hmac-diagnostic-v1";
const SHORT_HEX_PATTERN = /^[a-f0-9]{16}$/u;
const SCRIPT_SUFFIX_PATTERN = /^[A-Za-z0-9_-]{8}$/u;
const SAFE_ERROR_CODE_PATTERN = /^[A-Za-z0-9_:-]{1,60}$/u;
const SAFE_CONTENT_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;
type MutableHmacDiagnostic = {
  -readonly [Key in keyof HmacDiagnostic]?: HmacDiagnostic[Key];
};

interface GasHttpErrorDetails {
  readonly httpStatus: number;
  readonly contentType: string;
  readonly redirected: boolean;
  readonly upstreamErrorCode?: string;
  readonly diagnostic?: HmacDiagnostic;
}

export class ExternalApiError extends Error {
  public constructor(
    public readonly errorCode: string,
    public readonly retryable: boolean,
    details?: GasHttpErrorDetails,
  ) {
    super(errorCode);
    this.name = "ExternalApiError";
    this.httpStatus = details?.httpStatus;
    this.contentType = details?.contentType;
    this.redirected = details?.redirected;
    this.upstreamErrorCode = details?.upstreamErrorCode;
    this.diagnostic = details?.diagnostic;
  }

  public readonly httpStatus: number | undefined;
  public readonly contentType: string | undefined;
  public readonly redirected: boolean | undefined;
  public readonly upstreamErrorCode: string | undefined;
  public readonly diagnostic: HmacDiagnostic | undefined;
}

export async function createGasEnvelope(
  job: QueueJob,
  sharedSecret: string,
  timestamp: number = Date.now(),
  nonce: string = createNonce(),
  diagnosticEnabled = false,
): Promise<{
  readonly timestamp: number;
  readonly nonce: string;
  readonly payload: string;
  readonly signature: string;
  readonly workerDiagnostic?: HmacDiagnostic;
}> {
  const payload = JSON.stringify(job);
  const signingInput = `${String(timestamp)}.${nonce}.${payload}`;
  const signature = await computeWorkerEnvelopeSignature(
    timestamp,
    nonce,
    payload,
    sharedSecret,
  );
  if (!diagnosticEnabled) {
    return { timestamp, nonce, payload, signature };
  }
  return {
    timestamp,
    nonce,
    payload,
    signature,
    workerDiagnostic: {
      workerSecretFingerprint: (await hmacSha256Hex(
        HMAC_DIAGNOSTIC_PUBLIC_KEY,
        sharedSecret,
      )).slice(0, 16),
      workerSigningInputFingerprint: (await sha256Hex(signingInput)).slice(0, 16),
      workerSignaturePrefix: signature.slice(0, 16),
    },
  };
}

function parseGasDiagnostic(value: unknown): HmacDiagnostic | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const diagnostic: MutableHmacDiagnostic = {};
  const hexFields: Array<keyof HmacDiagnostic> = [
    "gasSecretFingerprint",
    "gasSigningInputFingerprint",
    "gasExpectedSignaturePrefix",
    "gasProvidedSignaturePrefix",
  ];
  for (const field of hexFields) {
    const fieldValue = value[field];
    if (typeof fieldValue === "string" && SHORT_HEX_PATTERN.test(fieldValue)) {
      diagnostic[field] = fieldValue;
    }
  }
  if (
    typeof value.gasScriptIdSuffix === "string" &&
    SCRIPT_SUFFIX_PATTERN.test(value.gasScriptIdSuffix)
  ) {
    diagnostic.gasScriptIdSuffix = value.gasScriptIdSuffix;
  }
  return Object.keys(diagnostic).length > 0 ? diagnostic : undefined;
}

function normalizeContentType(response: Response): string {
  const rawContentType = response.headers.get("content-type");
  const mediaType = rawContentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return SAFE_CONTENT_TYPE_PATTERN.test(mediaType) ? mediaType.slice(0, 100) : "unknown";
}

function isJsonContentType(contentType: string): boolean {
  return contentType === "application/json" || contentType.endsWith("+json");
}

async function inspectGasHttpResponse(
  response: Response,
  diagnosticEnabled: boolean,
): Promise<GasHttpErrorDetails> {
  const contentType = normalizeContentType(response);
  let upstreamErrorCode: string | undefined;
  let diagnostic: HmacDiagnostic | undefined;
  if (isJsonContentType(contentType)) {
    try {
      const value: unknown = await response.clone().json();
      if (
        isRecord(value) &&
        typeof value.ok === "boolean" &&
        typeof value.retryable === "boolean" &&
        typeof value.errorCode === "string" &&
        SAFE_ERROR_CODE_PATTERN.test(value.errorCode)
      ) {
        upstreamErrorCode = value.errorCode;
        if (diagnosticEnabled) {
          diagnostic = parseGasDiagnostic(value.diagnostic);
        }
      }
    } catch {
      // HTML、截斷內容或無效 JSON 均不可寫入 Log。
    }
  }
  return {
    httpStatus: response.status,
    contentType,
    redirected: response.redirected,
    ...(upstreamErrorCode === undefined ? {} : { upstreamErrorCode }),
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

function parseGasResult(value: unknown, diagnosticEnabled: boolean): GasResult {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new Error("GAS_INVALID_RESPONSE");
  }
  const result: {
    ok: boolean;
    replyMessage?: string;
    backupSuccessReply?: boolean;
    retryable?: boolean;
    errorCode?: string;
    retryAfterSeconds?: number;
    diagnostic?: HmacDiagnostic;
  } = { ok: value.ok };
  if (typeof value.replyMessage === "string") {
    result.replyMessage = value.replyMessage.slice(0, 5000);
  }
  if (typeof value.backupSuccessReply === "boolean") {
    result.backupSuccessReply = value.backupSuccessReply;
  }
  if (typeof value.retryable === "boolean") {
    result.retryable = value.retryable;
  }
  if (typeof value.errorCode === "string") {
    result.errorCode = value.errorCode.slice(0, 60);
  }
  if (
    Number.isSafeInteger(value.retryAfterSeconds) &&
    Number(value.retryAfterSeconds) >= 30 &&
    Number(value.retryAfterSeconds) <= 900
  ) {
    result.retryAfterSeconds = Number(value.retryAfterSeconds);
  }
  if (diagnosticEnabled) {
    const diagnostic = parseGasDiagnostic(value.diagnostic);
    if (diagnostic !== undefined) {
      result.diagnostic = diagnostic;
    }
  }
  return result;
}

export async function callGas(
  endpointUrl: string,
  sharedSecret: string,
  job: QueueJob,
  timeoutMilliseconds: number,
  diagnosticEnabled = false,
): Promise<GasResult> {
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpointUrl);
  } catch {
    throw new ExternalApiError("GAS_ENDPOINT_INVALID", false);
  }
  if (parsedEndpoint.protocol !== "https:") {
    throw new ExternalApiError("GAS_ENDPOINT_NOT_HTTPS", false);
  }
  let response: Response;
  const envelope = await createGasEnvelope(
    job,
    sharedSecret,
    Date.now(),
    createNonce(),
    diagnosticEnabled,
  );
  try {
    response = await fetchWithTimeout(
      parsedEndpoint,
      {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(envelope),
        redirect: "follow",
      },
      timeoutMilliseconds,
    );
  } catch {
    throw new ExternalApiError("GAS_NETWORK_ERROR", true);
  }
  if (!response.ok) {
    throw new ExternalApiError(
      "GAS_HTTP_ERROR",
      response.status >= 500,
      await inspectGasHttpResponse(response, diagnosticEnabled),
    );
  }
  try {
    const result = parseGasResult(await response.json(), diagnosticEnabled);
    return envelope.workerDiagnostic === undefined
      ? result
      : { ...result, workerDiagnostic: envelope.workerDiagnostic };
  } catch (error: unknown) {
    if (error instanceof ExternalApiError) {
      throw error;
    }
    throw new ExternalApiError(
      "GAS_HTTP_ERROR",
      true,
      await inspectGasHttpResponse(response, diagnosticEnabled),
    );
  }
}
