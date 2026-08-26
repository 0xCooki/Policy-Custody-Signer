import { existsSync } from "node:fs";

import { SignerBackend } from "src/signers/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    signerBackend: "local" as string,
    localPrivateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    softHsm: {
      modulePath: "",
      pin: "1234",
      slot: 0,
      keyLabel: "custody-eth",
    },
    mockMpc: {
      url: "http://127.0.0.1:3001",
      apiKey: "dev-mpc-secret",
      pollIntervalMs: 50,
      timeoutMs: 5000,
    },
  },
}));

vi.mock("src/config.js", () => ({
  config: mockConfig,
}));

const { createSigner } = await import("src/signers/createSigner.js");
const { LocalKeySigner } = await import("src/signers/localKey.js");
const { MockMpcSigner } = await import("src/signers/mockMpc.js");
const { SoftHsmSigner } = await import("src/signers/softHsm.js");

describe("createSigner", () => {
  beforeEach(() => {
    mockConfig.signerBackend = SignerBackend.Local;
    mockConfig.softHsm = {
      modulePath: "",
      pin: "1234",
      slot: 0,
      keyLabel: "custody-eth",
    };
  });

  it("returns LocalKeySigner for the local backend", () => {
    const signer = createSigner();
    expect(signer).toBeInstanceOf(LocalKeySigner);
    expect(signer.name).toBe(SignerBackend.Local);
  });

  it("requires SoftHSM module path for softhsm backend", () => {
    mockConfig.signerBackend = SignerBackend.SoftHsm;
    mockConfig.softHsm.modulePath = "";
    expect(() => createSigner()).toThrow(/SOFTHSM_MODULE_PATH/);
  });

  it.runIf(Boolean(process.env.SOFTHSM_MODULE_PATH && existsSync(process.env.SOFTHSM_MODULE_PATH)))(
    "returns SoftHsmSigner against a real SoftHSM module",
    () => {
      const modulePath = process.env.SOFTHSM_MODULE_PATH;
      if (!modulePath) throw new Error("SOFTHSM_MODULE_PATH required");

      mockConfig.signerBackend = SignerBackend.SoftHsm;
      mockConfig.softHsm = {
        modulePath,
        pin: process.env.SOFTHSM_PIN || "1234",
        slot: Number(process.env.SOFTHSM_SLOT || "0"),
        keyLabel: process.env.SOFTHSM_KEY_LABEL || "custody-eth",
      };
      const signer = createSigner();
      try {
        expect(signer).toBeInstanceOf(SoftHsmSigner);
        expect(signer.name).toBe(SignerBackend.SoftHsm);
      } finally {
        if (signer instanceof SoftHsmSigner) signer.close();
      }
    },
  );

  it("returns MockMpcSigner for the mock-mpc backend", () => {
    mockConfig.signerBackend = SignerBackend.MockMpc;
    const signer = createSigner();
    expect(signer).toBeInstanceOf(MockMpcSigner);
    expect(signer.name).toBe(SignerBackend.MockMpc);
  });

  it("throws for an unknown backend", () => {
    mockConfig.signerBackend = "unknown-backend";
    expect(() => createSigner()).toThrow(/Unknown signer backend/);
  });
});
