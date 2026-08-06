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

  it("只輸出固定長度診斷欄位，不輸出原始輸入", () => {
    const output: string[] = [];
    vi.spyOn(console, "info").mockImplementation((message: unknown) => {
      output.push(String(message));
    });

    safeLog("info", {
      component: "gas",
      status: "diagnostic",
      correlationId: "evt-diagnostic",
      diagnostic: {
        workerSecretFingerprint: "a".repeat(16),
        gasScriptIdSuffix: "Abc123-_",
        gasProvidedSignaturePrefix: "not-a-valid-prefix",
      },
    });

    const serialized = output.join(" ");
    expect(serialized).toContain("aaaaaaaaaaaaaaaa");
    expect(serialized).toContain("Abc123-_");
    expect(serialized).not.toContain("not-a-valid-prefix");
    expect(serialized).not.toContain("payload");
    expect(serialized).not.toContain("secret");
  });
});
