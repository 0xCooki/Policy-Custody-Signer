import { config } from "src/config.js";
import { LocalKeySigner } from "src/signers/localKey.js";
import type { Hex, SignerProvider } from "src/signers/types.js";

export function createSigner(): SignerProvider {
  switch (config.signerBackend) {
    case "local":
      return new LocalKeySigner(config.localPrivateKey as Hex);
    case "softhsm":
    case "mock-mpc":
      throw new Error(`Signer backend "${config.signerBackend}" not implemented yet`);
    default:
      throw new Error(`Unknown signer backend: ${config.signerBackend}`);
  }
}
