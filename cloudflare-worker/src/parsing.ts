import type { ParsedCommand } from "./types";

const EXACT_COMMANDS: Readonly<Record<string, ParsedCommand["name"]>> = {
  "狀態": "status",
  "重新授權": "reauthorize",
  "解除綁定": "unbind",
  "綁定群組": "bindGroup",
  "解除群組": "unbindGroup",
  "紀錄": "records",
  "查詢紀錄": "records",
  "備份清單": "groupSummary",
  "今日備份清單": "groupSummary",
  "本週備份清單": "groupSummary",
  "容量": "quota",
  "空間": "quota",
  "Drive容量": "quota",
  "群組容量": "groupQuota",
  "待審核": "pendingApproval",
  "說明": "help",
};

export function parseCommand(text: string): ParsedCommand | null {
  const normalized = text.trim();
  const exactCommand = EXACT_COMMANDS[normalized];
  if (exactCommand !== undefined) {
    return { name: exactCommand, argument: "" };
  }
  if (/^確認核准全部(?:\s|$)/u.test(normalized)) {
    return { name: "confirmApproveAll", argument: normalized.replace(/^確認核准全部\s*/u, "") };
  }
  if (/^(?:\d{1,2}月|\d{4}年\d{1,2}月|\d{4}-\d{2})\s*備份清單$/u.test(normalized)) {
    return { name: "groupSummary", argument: normalized };
  }
  if (/^.+備份清單$/u.test(normalized)) {
    return { name: "groupSummary", argument: normalized };
  }
  if (/^群組紀錄(?:\s|$)/u.test(normalized)) {
    return { name: "groupRecords", argument: normalized.slice(4).trim() };
  }
  if (/^確認拒絕全部(?:\s|$)/u.test(normalized)) {
    return { name: "confirmRejectAll", argument: normalized.replace(/^確認拒絕全部\s*/u, "") };
  }
  if (/^核准全部(?:\s|$)/u.test(normalized)) {
    return { name: "approve", argument: "全部" };
  }
  if (/^拒絕全部(?:\s|$)/u.test(normalized)) {
    return { name: "reject", argument: "全部" };
  }
  if (/^綁定(?:\s|$)/u.test(normalized)) {
    return { name: "bind", argument: normalized.slice(2).trim() };
  }
  if (/^核准(?:\s|$)/u.test(normalized)) {
    return { name: "approve", argument: normalized.slice(2).trim() };
  }
  if (/^拒絕(?:\s|$)/u.test(normalized)) {
    return { name: "reject", argument: normalized.slice(2).trim() };
  }
  if (/^#筆記(?:\s|$)/u.test(normalized)) {
    return { name: "note", argument: normalized.slice(3).trim() };
  }
  return null;
}

export function extractTags(text: string): string[] {
  const tags = new Set<string>();
  for (const match of text.matchAll(/#([\p{L}\p{N}_-]{1,50})/gu)) {
    const tag = match[1];
    if (tag !== undefined && tag !== "筆記") {
      tags.add(tag);
    }
  }
  return [...tags].slice(0, 20);
}

export function extractUrls(text: string): string[] {
  const urls = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'，。；、！？]{1,2048}/giu)) {
    const rawUrl = match[0].replace(/[。；，、！？.!?,;:]+$/u, "");
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        urls.add(parsed.toString());
      }
    } catch {
      // 非法 URL 不進入備份欄位。
    }
  }
  return [...urls].slice(0, 20);
}

export function isOverFileSizeLimit(
  fileSize: number | null,
  maximumFileSizeBytes: number,
): boolean {
  return fileSize !== null && fileSize > maximumFileSizeBytes;
}
