import { afterEach, describe, expect, it, vi } from "vitest";
import { safeLog } from "../src/logger";

describe("安全 Log", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("只輸出白名單欄位，不會輸出呼叫端持有的 Secret", () => {
    const output: string[] = [];
    vi.spyOn(console, "info").mockImplementation((message: unknown) => {
      output.push(String(message));
    });
    const secretThatMustNotAppear = "super-secret-token";

    safeLog("info", {
      component: "webhook",
      status: "accepted",
      correlationId: "evt-001",
    });

    expect(output.join(" ")).not.toContain(secretThatMustNotAppear);
    expect(output.join(" ")).toContain("evt-001");
  });
});
