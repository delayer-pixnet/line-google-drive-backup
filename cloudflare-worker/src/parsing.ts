import type { ParsedCommand } from "./types";

const EXACT_COMMANDS: Readonly<Record<string, ParsedCommand["name"]>> = {
  "狀態": "status",
  "解除綁定": "unbind",
  "綁定群組": "bindGroup",
  "解除群組": "unbindGroup",
  "說明": "help",
};

export function parseCommand(text: string): ParsedCommand | null {
  const normalized = text.trim();
  const exactCommand = EXACT_COMMANDS[normalized];
  if (exactCommand !== undefined) {
    return { name: exactCommand, argument: "" };
  }
  if (/^綁定(?:\s|$)/u.test(normalized)) {
    return { name: "bind", argument: normalized.slice(2).trim() };
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
