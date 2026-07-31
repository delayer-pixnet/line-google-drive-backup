export interface SafeLogEntry {
  readonly component: "webhook" | "queue" | "gas" | "line";
  readonly status: "accepted" | "ignored" | "completed" | "failed" | "retrying";
  readonly correlationId?: string;
  readonly errorCode?: string;
}

export function safeLog(
  level: "info" | "warn" | "error",
  entry: SafeLogEntry,
): void {
  // 僅輸出白名單欄位，避免呼叫端誤把 Token、Secret 或訊息內容寫入 Log。
  const serialized = JSON.stringify({
    component: entry.component,
    status: entry.status,
    ...(entry.correlationId === undefined
      ? {}
      : { correlationId: entry.correlationId.slice(0, 100) }),
    ...(entry.errorCode === undefined ? {} : { errorCode: entry.errorCode.slice(0, 60) }),
  });
  if (level === "error") {
    console.error(serialized);
  } else if (level === "warn") {
    console.warn(serialized);
  } else {
    console.info(serialized);
  }
}
