import { createRequire } from "node:module";

import type { Session, SessionObject } from "graphene-pk11";
import type { config } from "src/config.js";
import type { Hex } from "src/signers/types.js";
import { hexToBytes, toHex } from "viem";

export type SoftHsmCfg = (typeof config)["softHsm"];

export interface Pkcs11Client {
  /** Uncompressed secp256k1 public key: 0x04 || X || Y */
  getPublicKeyPoint(label?: string): Promise<Hex>;
  /** ECDSA over a 32-byte digest; returns r||s as 0x-prefixed 64-byte hex */
  signEcdsa(digest: Hex, label?: string): Promise<Hex>;
  close?(): void;
}

/**
 * Load SoftHSM via graphene only when a real client is constructed.
 * Keeps LocalKey / API imports from requiring the pkcs11 native addon.
 *
 * Session ops are serialized: one shared PKCS#11 session is not safe for
 * concurrent createSign/find from overlapping awaits.
 */
export function createGraphenePkcs11Client(cfg: SoftHsmCfg): Pkcs11Client {
  if (!cfg.modulePath) {
    throw new Error("SOFTHSM_MODULE_PATH is required for SoftHSM");
  }

  if (!cfg.keyLabel) {
    throw new Error("SOFTHSM_KEY_LABEL is required for SoftHSM");
  }

  const require = createRequire(import.meta.url);
  const graphene = require("graphene-pk11") as typeof import("graphene-pk11");

  const mod = graphene.Module.load(cfg.modulePath, "SoftHSM");
  mod.initialize();

  const slots = mod.getSlots(true);
  if (!slots.length) {
    throw new Error("No SoftHSM slots with a token present");
  }
  const slotIndex = cfg.slot;
  if (slotIndex < 0 || slotIndex >= slots.length) {
    throw new Error(`SoftHSM slot index ${slotIndex} out of range (have ${slots.length})`);
  }
  const slot = slots.items(slotIndex);

  const session = slot.open(graphene.SessionFlag.SERIAL_SESSION | graphene.SessionFlag.RW_SESSION);
  session.login(cfg.pin);

  const index = 0;
  const withSessionLock = createSessionLock();

  return {
    async getPublicKeyPoint(label?: string): Promise<Hex> {
      return withSessionLock(() => {
        const key = findKey(
          session,
          graphene.ObjectClass.PUBLIC_KEY,
          resolveLabel(cfg, label),
          index,
        );
        const ecPoint = key.get("pointEC") as Buffer;
        const uncompressed = unwrapEcPoint(ecPoint);
        return toHex(uncompressed);
      });
    },
    async signEcdsa(digest: Hex, label?: string): Promise<Hex> {
      const digestBytes = hexToBytes(digest);
      if (digestBytes.length !== 32) {
        throw new Error(`ECDSA digest must be 32 bytes, got ${digestBytes.length}`);
      }
      return withSessionLock(() => {
        const privateKey = findKey(
          session,
          graphene.ObjectClass.PRIVATE_KEY,
          resolveLabel(cfg, label),
          index,
        );
        const sign = session.createSign("ECDSA", privateKey.toType());
        const signature = sign.once(Buffer.from(digestBytes));
        if (signature.length !== 64) {
          throw new Error(`Unexpected ECDSA signature length: ${signature.length}`);
        }
        return toHex(signature);
      });
    },
    close() {
      try {
        session.logout();
      } finally {
        session.close();
        mod.finalize();
      }
    },
  };
}

/** Promise-chain mutex: runs tasks one at a time, even when started concurrently. */
export function createSessionLock(): <T>(fn: () => T | Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return function withSessionLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = tail.then(() => fn());
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

function resolveLabel(cfg: SoftHsmCfg, label?: string): string {
  return label ? label : cfg.keyLabel;
}

function findKey(
  session: Session,
  objectClass: number,
  label: string,
  index: number,
): SessionObject {
  const objects = session.find({
    class: objectClass,
    label,
  });
  if (!objects.length) {
    throw new Error(`SoftHSM key not found for label="${label}" class=${objectClass}`);
  }
  return objects.items(index);
}

function unwrapEcPoint(ecPoint: Buffer): Uint8Array {
  if (ecPoint.length === 65 && ecPoint[0] === 0x04) {
    return new Uint8Array(ecPoint);
  }
  if (ecPoint[0] === 0x04 && ecPoint.length > 2) {
    const len = ecPoint[1];
    return new Uint8Array(ecPoint.subarray(2, 2 + len));
  }
  throw new Error("Unrecognised CKA_EC_POINT encoding");
}
