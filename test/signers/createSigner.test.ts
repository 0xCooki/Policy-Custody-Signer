import { SignerBackend } from "src/signers/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    signerBackend: "local" as string,
    localPrivateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  },
}));

vi.mock("src/config.js", () => ({
  config: mockConfig,
}));

const { createSigner } = await import("src/signers/createSigner.js");
const { LocalKeySigner } = await import("src/signers/localKey.js");

describe("createSigner", () => {
  beforeEach(() => {
    mockConfig.signerBackend = SignerBackend.Local;
  });

  it("returns LocalKeySigner for the local backend", () => {
    const signer = createSigner();
    expect(signer).toBeInstanceOf(LocalKeySigner);
    expect(signer.name).toBe(SignerBackend.Local);
  });

  it("throws for SoftHSM until implemented", () => {
    mockConfig.signerBackend = SignerBackend.SoftHsm;
    expect(() => createSigner()).toThrow(/not implemented yet/);
  });

  it("throws for MockMpc until implemented", () => {
    mockConfig.signerBackend = SignerBackend.MockMpc;
    expect(() => createSigner()).toThrow(/not implemented yet/);
  });

  it("throws for an unknown backend", () => {
    mockConfig.signerBackend = "unknown-backend";
    expect(() => createSigner()).toThrow(/Unknown signer backend/);
  });
});
