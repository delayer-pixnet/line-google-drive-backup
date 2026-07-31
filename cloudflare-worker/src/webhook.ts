import { createBindToken, hmacSha256Hex } from "./crypto";
import { isOverFileSizeLimit, parseCommand } from "./parsing";
import type {
  CommandName,
  QueueJob,
  SupportedEventType,
  SupportedMessageType,
} from "./types";
import { isRecord, optionalSafeInteger, optionalString } from "./validation";

const SUPPORTED_EVENT_TYPES = new Set<SupportedEventType>([
  "message",
  "join",
  "leave",
  "follow",
  "unfollow",
  "unsend",
]);
const SUPPORTED_MESSAGE_TYPES = new Set<SupportedMessageType>([
  "text",
  "image",
  "video",
  "audio",
  "file",
]);

function isSupportedEventType(value: unknown): value is SupportedEventType {
  return typeof value === "string" && SUPPORTED_EVENT_TYPES.has(value as SupportedEventType);
}

function isSupportedMessageType(value: unknown): value is SupportedMessageType {
  return typeof value === "string" && SUPPORTED_MESSAGE_TYPES.has(value as SupportedMessageType);
}

function hasBotMention(message: Record<string, unknown>): boolean {
  const mention = message.mention;
  if (!isRecord(mention) || !Array.isArray(mention.mentionees)) {
    return false;
  }
  return mention.mentionees.some(
    (mentionee) => isRecord(mentionee) && mentionee.isSelf === true,
  );
}

function getSource(event: Record<string, unknown>): {
  lineUserId: string | null;
  groupId: string | null;
  isGroup: boolean;
} {
  const source = event.source;
  if (!isRecord(source)) {
    return { lineUserId: null, groupId: null, isGroup: false };
  }
  const sourceType = optionalString(source.type, 20);
  return {
    lineUserId: optionalString(source.userId, 100),
    groupId: sourceType === "group" ? optionalString(source.groupId, 100) : null,
    isGroup: sourceType === "group",
  };
}

async function parseEvent(
  eventValue: unknown,
  identifierHashSecret: string,
  bindTokenSecret: string,
  bindTokenTtlSeconds: number,
  maximumFileSizeBytes: number,
  nowMilliseconds: number,
): Promise<QueueJob | null> {
  if (!isRecord(eventValue) || !isSupportedEventType(eventValue.type)) {
    return null;
  }
  const eventType = eventValue.type;
  const webhookEventId = optionalString(eventValue.webhookEventId, 128);
  const timestamp = optionalSafeInteger(eventValue.timestamp);
  if (webhookEventId === null || timestamp === null) {
    return null;
  }
  const source = getSource(eventValue);
  const replyToken = optionalString(eventValue.replyToken, 256);
  let messageId: string | null = null;
  let messageType: SupportedMessageType | null = null;
  let fileName: string | null = null;
  let fileSize: number | null = null;
  let rawText: string | null = null;
  let command: CommandName | null = null;
  let shouldSave = false;
  let rejectionCode: QueueJob["rejectionCode"] = null;

  if (eventType === "message") {
    const message = eventValue.message;
    if (!isRecord(message) || !isSupportedMessageType(message.type)) {
      return null;
    }
    messageId = optionalString(message.id, 128);
    if (messageId === null) {
      return null;
    }
    messageType = message.type;
    if (messageType === "text") {
      rawText = optionalString(message.text, 5000);
      if (rawText === null) {
        return null;
      }
      const parsedCommand = parseCommand(rawText);
      command = parsedCommand?.name ?? null;
      shouldSave = command === "note" || command === null;
      if (source.isGroup && command === null && !hasBotMention(message)) {
        return null;
      }
    } else {
      shouldSave = true;
      if (messageType === "file") {
        fileName = optionalString(message.fileName, 255);
        fileSize = optionalSafeInteger(message.fileSize);
      }
      if (isOverFileSizeLimit(fileSize, maximumFileSizeBytes)) {
        shouldSave = false;
        rejectionCode = "FILE_TOO_LARGE";
      }
    }
  } else if (eventType === "unsend") {
    const unsend = eventValue.unsend;
    if (!isRecord(unsend)) {
      return null;
    }
    messageId = optionalString(unsend.messageId, 128);
    if (messageId === null) {
      return null;
    }
  }

  const bindToken =
    command === "bind" && source.lineUserId !== null
      ? await createBindToken(
          await hmacSha256Hex(identifierHashSecret, source.lineUserId),
          bindTokenSecret,
          nowMilliseconds,
          bindTokenTtlSeconds,
        )
      : null;

  return {
    schemaVersion: 1,
    eventType,
    webhookEventId,
    messageId,
    messageType,
    lineUserId: source.lineUserId,
    groupId: source.groupId,
    replyToken,
    timestamp,
    fileName,
    fileSize,
    rawText,
    command,
    shouldSave,
    rejectionCode,
    bindToken,
  };
}

export async function parseWebhookBody(
  parsedBody: unknown,
  identifierHashSecret: string,
  bindTokenSecret: string,
  bindTokenTtlSeconds: number,
  maximumFileSizeBytes: number,
  nowMilliseconds: number = Date.now(),
): Promise<QueueJob[]> {
  if (!isRecord(parsedBody) || !Array.isArray(parsedBody.events)) {
    throw new Error("Webhook JSON 格式不正確。");
  }
  const parsedJobs = await Promise.all(
    parsedBody.events.slice(0, 100).map((event) =>
      parseEvent(
        event,
        identifierHashSecret,
        bindTokenSecret,
        bindTokenTtlSeconds,
        maximumFileSizeBytes,
        nowMilliseconds,
      ),
    ),
  );
  return parsedJobs.filter((job): job is QueueJob => job !== null);
}
