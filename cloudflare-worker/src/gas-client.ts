import { createNonce, hmacSha256Hex } from "./crypto";
import { fetchWithTimeout } from "./http";
import type { GasResult, QueueJob } from "./types";
import { isRecord } from "./validation";

export class ExternalApiError extends Error {
  public constructor(
    public readonly errorCode: string,
    public readonly retryable: boolean,
  ) {
    super(errorCode);
    this.name = "ExternalApiError";
  }
}

export async function createGasEnvelope(
  job: QueueJob,
  sharedSecret: string,
  timestamp: number = Date.now(),
  nonce: string = createNonce(),
): Promise<{
  readonly timestamp: number;
  readonly nonce: string;
  readonly payload: string;
  readonly signature: string;
}> {
  const payload = JSON.stringify(job);
  const signature = await hmacSha256Hex(
    sharedSecret,
    `${String(timestamp)}.${nonce}.${payload}`,
  );
  return { timestamp, nonce, payload, signature };
}

function parseGasResult(value: unknown): GasResult {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new ExternalApiError("GAS_INVALID_RESPONSE", true);
  }
  const result: {
    ok: boolean;
    replyMessage?: string;
    retryable?: boolean;
    errorCode?: string;
    retryAfterSeconds?: number;
  } = { ok: value.ok };
  if (typeof value.replyMessage === "string") {
    result.replyMessage = value.replyMessage.slice(0, 5000);
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
  return result;
}

export async function callGas(
  endpointUrl: string,
  sharedSecret: string,
  job: QueueJob,
  timeoutMilliseconds: number,
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
  try {
    response = await fetchWithTimeout(
      parsedEndpoint,
      {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(await createGasEnvelope(job, sharedSecret)),
        redirect: "follow",
      },
      timeoutMilliseconds,
    );
  } catch {
    throw new ExternalApiError("GAS_NETWORK_ERROR", true);
  }
  if (!response.ok) {
    throw new ExternalApiError("GAS_HTTP_ERROR", response.status >= 500);
  }
  try {
    return parseGasResult(await response.json());
  } catch (error: unknown) {
    if (error instanceof ExternalApiError) {
      throw error;
    }
    throw new ExternalApiError("GAS_INVALID_JSON", true);
  }
}
