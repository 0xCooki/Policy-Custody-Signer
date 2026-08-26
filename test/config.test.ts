import { SignerBackend } from "src/signers/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

describe("config", () => {
  const previous = {
    SIGNER_BACKEND: process.env.SIGNER_BACKEND,
    MOCK_MPC_POLL_INTERVAL_MS: process.env.MOCK_MPC_POLL_INTERVAL_MS,
    MOCK_MPC_TIMEOUT_MS: process.env.MOCK_MPC_TIMEOUT_MS,
    PORT: process.env.PORT,
    POLICY_ALLOWLIST: process.env.POLICY_ALLOWLIST,
  };

  afterEach(() => {
    for (const [name, value] of Object.entries(previous)) {
      restoreEnv(name, value);
    }
    vi.resetModules();
  });

  it("accepts a valid backend", async () => {
    process.env.SIGNER_BACKEND = SignerBackend.Local;
    vi.resetModules();
    const { config } = await import("src/config.js");
    expect(config.signerBackend).toBe(SignerBackend.Local);
  });

  it("defaults to local when SIGNER_BACKEND is empty", async () => {
    process.env.SIGNER_BACKEND = "";
    vi.resetModules();
    const { config } = await import("src/config.js");
    expect(config.signerBackend).toBe(SignerBackend.Local);
  });

  it("rejects an invalid backend", async () => {
    process.env.SIGNER_BACKEND = "not-a-backend";
    vi.resetModules();
    await expect(import("src/config.js")).rejects.toThrow(/Invalid SIGNER_BACKEND="not-a-backend"/);
  });

  it("rejects a non-positive mock-mpc poll interval or timeout", async () => {
    process.env.MOCK_MPC_POLL_INTERVAL_MS = "0";
    vi.resetModules();
    await expect(import("src/config.js")).rejects.toThrow(/MOCK_MPC_POLL_INTERVAL_MS/);

    delete process.env.MOCK_MPC_POLL_INTERVAL_MS;
    process.env.MOCK_MPC_TIMEOUT_MS = "-5";
    vi.resetModules();
    await expect(import("src/config.js")).rejects.toThrow(/MOCK_MPC_TIMEOUT_MS/);
  });

  it("accepts a positive mock-mpc poll interval and timeout", async () => {
    process.env.MOCK_MPC_POLL_INTERVAL_MS = "100";
    process.env.MOCK_MPC_TIMEOUT_MS = "2000";
    vi.resetModules();
    const { config } = await import("src/config.js");
    expect(config.mockMpc.pollIntervalMs).toBe(100);
    expect(config.mockMpc.timeoutMs).toBe(2000);
  });

  it("falls back for a non-integer or empty PORT", async () => {
    process.env.PORT = "abc";
    vi.resetModules();
    expect((await import("src/config.js")).config.port).toBe(3000);

    process.env.PORT = "";
    vi.resetModules();
    expect((await import("src/config.js")).config.port).toBe(3000);
  });

  it("parses a CSV policy allowlist", async () => {
    process.env.POLICY_ALLOWLIST =
      " 0x00000000000000000000000000000000000000c8, 0x00000000000000000000000000000000000000c9 ";
    vi.resetModules();
    const { config } = await import("src/config.js");
    expect(config.policy.allowlist).toEqual([
      "0x00000000000000000000000000000000000000c8",
      "0x00000000000000000000000000000000000000c9",
    ]);
  });
});
