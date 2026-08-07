export type SupportedEventType =
  | "message"
  | "join"
  | "leave"
  | "follow"
  | "unfollow"
  | "unsend";

export type SupportedMessageType = "text" | "image" | "video" | "audio" | "file";

export type CommandName =
  | "bind"
  | "status"
  | "unbind"
  | "bindGroup"
  | "unbindGroup"
  | "pendingApproval"
  | "approve"
  | "reject"
  | "confirmApproveAll"
  | "confirmRejectAll"
  | "note"
  | "help";

export interface ParsedCommand {
  readonly name: CommandName;
  readonly argument: string;
}

export interface QueueJob {
  readonly schemaVersion: 1;
  readonly eventType: SupportedEventType;
  readonly webhookEventId: string;
  readonly messageId: string | null;
  readonly messageType: SupportedMessageType | null;
  readonly lineUserId: string | null;
  readonly groupId: string | null;
  readonly replyToken: string | null;
  readonly timestamp: number;
  readonly fileName: string | null;
  readonly fileSize: number | null;
  readonly rawText: string | null;
  readonly command: CommandName | null;
  readonly shouldSave: boolean;
  readonly rejectionCode: "FILE_TOO_LARGE" | null;
  readonly bindToken: string | null;
}

export interface Env {
  readonly BACKUP_QUEUE: Queue<QueueJob>;
  readonly LINE_CHANNEL_SECRET: string;
  readonly LINE_CHANNEL_ACCESS_TOKEN: string;
  readonly GAS_ENDPOINT_URL: string;
  readonly WORKER_GAS_SHARED_SECRET: string;
  readonly BIND_TOKEN_SECRET: string;
  readonly IDENTIFIER_HASH_SECRET: string;
  readonly MAX_FILE_SIZE_BYTES?: string;
  readonly BIND_TOKEN_TTL_SECONDS?: string;
  readonly GAS_REQUEST_TIMEOUT_MS?: string;
  readonly ENABLE_BACKUP_SUCCESS_REPLY?: string;
  readonly ENABLE_PUSH_FALLBACK?: string;
  readonly HMAC_DIAGNOSTIC_ENABLED?: string;
}

export interface HmacDiagnostic {
  readonly workerSecretFingerprint?: string;
  readonly workerSigningInputFingerprint?: string;
  readonly workerSignaturePrefix?: string;
  readonly gasSecretFingerprint?: string;
  readonly gasSigningInputFingerprint?: string;
  readonly gasExpectedSignaturePrefix?: string;
  readonly gasProvidedSignaturePrefix?: string;
  readonly gasScriptIdSuffix?: string;
}

export interface GasResult {
  readonly ok: boolean;
  readonly replyMessage?: string;
  readonly backupSuccessReply?: boolean;
  readonly retryable?: boolean;
  readonly errorCode?: string;
  readonly retryAfterSeconds?: number;
  readonly diagnostic?: HmacDiagnostic;
  readonly workerDiagnostic?: HmacDiagnostic;
}
