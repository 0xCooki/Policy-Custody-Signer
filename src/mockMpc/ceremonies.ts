import { randomUUID } from "node:crypto";
import {
  type Ceremony,
  CeremonyConflictError,
  CeremonyError,
  CeremonyStatus,
  fingerprintTx,
  type ParticipantId,
} from "src/mockMpc/types.js";
import type { Hex, UnsignedTx } from "src/signers/types.js";
import { privateKeyToAccount } from "viem/accounts";

/** Anvil account #0 — DEV ONLY. This service simulates a vendor; it does not protect the key. */
export const MOCK_MPC_DEV_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

export const PARTICIPANT_IDS: readonly ParticipantId[] = [0, 1, 2];
export const THRESHOLD = 2;

export function signUnsignedTx(privateKey: Hex, tx: UnsignedTx): Promise<Hex> {
  return privateKeyToAccount(privateKey).signTransaction({
    to: tx.to,
    value: tx.value,
    data: tx.data,
    nonce: tx.nonce,
    gas: tx.gas,
    maxFeePerGas: tx.maxFeePerGas,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    chainId: tx.chainId,
    type: "eip1559",
  });
}

export type CeremonyStoreOpts = {
  sign?: (tx: UnsignedTx) => Promise<Hex>;
  id?: () => string;
  available?: Iterable<ParticipantId>;
  privateKey?: Hex;
};

export class CeremonyStore {
  private readonly byId = new Map<string, Ceremony>();
  private readonly byKey = new Map<string, string>();
  private readonly sign: (tx: UnsignedTx) => Promise<Hex>;
  private readonly id: () => string;
  private available: Set<ParticipantId>;

  constructor(opts: CeremonyStoreOpts = {}) {
    this.sign = opts.sign ?? ((tx) => signUnsignedTx(opts.privateKey ?? MOCK_MPC_DEV_KEY, tx));
    this.id = opts.id ?? randomUUID;
    this.available = new Set(opts.available ?? PARTICIPANT_IDS);
  }

  setAvailable(ids: Iterable<ParticipantId>): void {
    this.available = new Set(ids);
  }

  get(requestId: string): Ceremony | undefined {
    return this.byId.get(requestId);
  }

  getAvailable(): ParticipantId[] {
    return [...this.available].sort((a, b) => a - b);
  }

  async create(tx: UnsignedTx, idempotencyKey: string): Promise<Ceremony> {
    const fingerprint = fingerprintTx(tx);
    const existingId = this.byKey.get(idempotencyKey);
    if (existingId !== undefined) {
      const existing = this.byId.get(existingId);
      if (!existing) throw new Error(`missing ceremony for key ${idempotencyKey}`);
      if (existing.status !== CeremonyStatus.Failed) {
        if (existing.fingerprint !== fingerprint) throw new CeremonyConflictError();
        return existing;
      }
      this.byKey.delete(idempotencyKey);
    }

    const requestId = this.id();
    const availableCount = this.available.size;
    const ceremony: Ceremony = {
      requestId,
      idempotencyKey,
      fingerprint,
      status: CeremonyStatus.Pending,
      participantsCompleted: 0,
      threshold: THRESHOLD,
    };

    this.byId.set(requestId, ceremony);
    this.byKey.set(idempotencyKey, requestId);

    if (availableCount < THRESHOLD) {
      ceremony.status = CeremonyStatus.Failed;
      ceremony.error = CeremonyError.ThresholdNotMet;
      return ceremony;
    }

    ceremony.status = CeremonyStatus.Signing;
    try {
      ceremony.signedTransaction = await this.sign(tx);
      ceremony.participantsCompleted = availableCount;
      ceremony.status = CeremonyStatus.Completed;
    } catch (err) {
      this.byId.delete(requestId);
      this.byKey.delete(idempotencyKey);
      throw err;
    }
    return ceremony;
  }
}
