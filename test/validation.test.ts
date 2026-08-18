import { describe, expect, it } from "vitest";
import { requireNonEmpty } from "../src/validation";

describe("必要設定正規化", () => {
  it("正常 Secret 原樣回傳", () => {
    expect(requireNonEmpty("worker-shared-secret", "TEST_SECRET")).toBe("worker-shared-secret");
  });

  it("移除前後空白", () => {
    expect(requireNonEmpty("  worker-shared-secret  ", "TEST_SECRET")).toBe("worker-shared-secret");
  });

  it("移除結尾換行", () => {
    expect(requireNonEmpty("worker-shared-secret\r\n", "TEST_SECRET")).toBe("worker-shared-secret");
  });

  it("全空白仍拋出缺少設定錯誤", () => {
    expect(() => requireNonEmpty(" \t\r\n", "TEST_SECRET")).toThrow("缺少必要設定：TEST_SECRET");
  });
});
