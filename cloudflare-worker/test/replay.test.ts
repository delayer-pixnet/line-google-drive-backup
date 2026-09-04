import { describe, expect, it } from "vitest";
import { computeWorkerEnvelopeSignature } from "../src/crypto";
import { handleRequest } from "../src/index";
import type { Env, QueueJob } from "../src/types";

const SHARED_SECRET = "test-replay-shared-secret";

function createReplayJob(): QueueJob {
  return {
    schemaVersion: 1,
    eventType: "message",
    webhookEventId: "evt-replay-001",
    messageId: "msg-replay-001",
    messageType: "file",
    lineUserHash: "a".repeat(64),
    groupIdHash: "b".repeat(64),
    senderDisplayName: "測試使用者",
    groupDisplayName: "測試群組",
    replyToken: null,
    timestamp: Date.now(),
    fileName: "測試.pdf",
    fileSize: null,
    rawText: null,
    command: null,
    shouldSave: true,
    rejectionCode: null,
    bindToken: null,
  };
}

function createEnv(sentJobs: QueueJob[]): Env {
  return {
    BACKUP_QUEUE: {
      send: (job: QueueJob) => {
        sentJobs.push(job);
        return Promise.resolve();
      },
    } as unknown as Queue<QueueJob>,
    LINE_CHANNEL_SECRET: "line-secret",
    LINE_CHANNEL_ACCESS_TOKEN: "line-token",
    GAS_ENDPOINT_URL: "https://example.invalid/exec",
    WORKER_GAS_SHARED_SECRET: SHARED_SECRET,
    BIND_TOKEN_SECRET: "bind-secret",
    IDENTIFIER_HASH_SECRET: "identifier-secret",
  };
}

async function signedReplayRequest(payload: string, timestamp: number, nonce: string): Promise<Request> {
  const signature = await computeWorkerEnvelopeSignature(timestamp, nonce, payload, SHARED_SECRET);
  return new Request("https://worker.example/internal/replay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ timestamp, nonce, payload, signature }),
  });
}

describe("補備份內部佇列端點", () => {
  it("驗證 HMAC 後只將安全工作中繼資料放入 Queue", async () => {
    const sentJobs: QueueJob[] = [];
    const payload = JSON.stringify({ jobs: [createReplayJob()] });
    const response = await handleRequest(
      await signedReplayRequest(payload, Date.now(), "0123456789abcdef0123456789abcdef"),
      createEnv(sentJobs),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, acceptedCount: 1 });
    expect(sentJobs).toHaveLength(1);
    expect(sentJobs[0]?.replyToken).toBeNull();
  });

  it("無效 HMAC 不會建立補備份工作", async () => {
    const sentJobs: QueueJob[] = [];
    const payload = JSON.stringify({ jobs: [createReplayJob()] });
    const request = new Request("https://worker.example/internal/replay", {
      method: "POST",
      body: JSON.stringify({
        timestamp: Date.now(),
        nonce: "0123456789abcdef0123456789abcdef",
        payload,
        signature: "0".repeat(64),
      }),
    });

    const response = await handleRequest(request, createEnv(sentJobs));

    expect(response.status).toBe(401);
    expect(sentJobs).toHaveLength(0);
  });
});
