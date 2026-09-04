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
  | "reauthorize"
  | "status"
  | "systemStatus"
  | "unbind"
  | "bindGroup"
  | "unbindGroup"
  | "records"
  | "groupSummary"
  | "groupRecords"
  | "quota"
  | "groupQuota"
  | "groupReplay"
  | "manualGroupReplay"
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
  /** 只傳遞 HMAC 雜湊；原始 LINE 識別不進入 Queue 或 GAS。 */
  readonly lineUserHash: string | null;
  readonly groupIdHash: string | null;
  readonly senderDisplayName: string | null;
  readonly groupDisplayName: string | null;
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
