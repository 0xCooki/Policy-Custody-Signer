import { SignerBackend } from "src/signers/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("config SIGNER_BACKEND", () => {
  const previous = process.env.SIGNER_BACKEND;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.SIGNER_BACKEND;
    } else {
      process.env.SIGNER_BACKEND = previous;
    }
    vi.resetModules();
  });

  it("accepts a valid backend", async () => {
    process.env.SIGNER_BACKEND = SignerBackend.Local;
    vi.resetModules();
    const { config } = await import("src/config.js");
    expect(config.signerBackend).toBe(SignerBackend.Local);
  });

  it("rejects an invalid backend", async () => {
    process.env.SIGNER_BACKEND = "not-a-backend";
    vi.resetModules();
    await expect(import("src/config.js")).rejects.toThrow(/Invalid SIGNER_BACKEND="not-a-backend"/);
  });
});
