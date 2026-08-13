import { config } from "src/config.js";
import { LocalKeySigner } from "src/signers/localKey.js";
import { SoftHsmSigner } from "src/signers/softHsm.js";
import { type Hex, SignerBackend, type SignerProvider } from "src/signers/types.js";

export function createSigner(): SignerProvider {
  switch (config.signerBackend) {
    case SignerBackend.Local:
      return new LocalKeySigner(config.localPrivateKey as Hex);
    case SignerBackend.SoftHsm:
      return new SoftHsmSigner(config.softHsm);
    case SignerBackend.MockMpc:
      throw new Error(`Signer backend "${config.signerBackend}" not implemented yet`);
    default:
      throw new Error(`Unknown signer backend: ${config.signerBackend}`);
  }
}
