import { describe, expect, it } from "vitest";
import { extractTags, extractUrls, isOverFileSizeLimit, parseCommand } from "../src/parsing";

describe("指令解析", () => {
  it.each([
    ["綁定 ABCD-1234", "bind", "ABCD-1234"],
    ["狀態", "status", ""],
    ["解除綁定", "unbind", ""],
    ["綁定群組", "bindGroup", ""],
    ["解除群組", "unbindGroup", ""],
    ["待審核", "pendingApproval", ""],
    ["核准 UABC12345", "approve", "UABC12345"],
    ["拒絕 UABC12345", "reject", "UABC12345"],
    ["核准 1,2,3", "approve", "1,2,3"],
    ["拒絕 1,2,3", "reject", "1,2,3"],
    ["核准全部", "approve", "全部"],
    ["拒絕全部", "reject", "全部"],
    ["確認核准全部 ABCD1234", "confirmApproveAll", "ABCD1234"],
    ["確認拒絕全部 ABCD1234", "confirmRejectAll", "ABCD1234"],
    ["#筆記 要保存的內容", "note", "要保存的內容"],
    ["說明", "help", ""],
  ])("解析 %s", (input, name, argument) => {
    expect(parseCommand(input)).toEqual({ name, argument });
  });

  it("一般文字不是指令", () => {
    expect(parseCommand("今天要記得備份")).toBeNull();
  });
});

describe("文字欄位解析", () => {
  it("去重並擷取標籤，且排除控制用的筆記標籤", () => {
    expect(extractTags("#筆記 #旅遊 看 #台北，#旅遊 #summer-2026")).toEqual([
      "旅遊",
      "台北",
      "summer-2026",
    ]);
  });

  it("擷取 HTTP 與 HTTPS 網址並移除句尾標點", () => {
    expect(extractUrls("參考 https://example.com/a?q=1，或 http://example.org。"))
      .toEqual(["https://example.com/a?q=1", "http://example.org/"]);
  });
});

describe("檔案上限", () => {
  const maximum = 20 * 1024 * 1024;

  it("20 MiB 可接受，超過 1 byte 即拒絕", () => {
    expect(isOverFileSizeLimit(maximum, maximum)).toBe(false);
    expect(isOverFileSizeLimit(maximum + 1, maximum)).toBe(true);
    expect(isOverFileSizeLimit(null, maximum)).toBe(false);
  });
});
