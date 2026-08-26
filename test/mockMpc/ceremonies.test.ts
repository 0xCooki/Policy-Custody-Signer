import { CeremonyStore, THRESHOLD } from "src/mockMpc/ceremonies.js";
import {
  CeremonyConflictError,
  CeremonyError,
  CeremonyStatus,
  type ParticipantId,
} from "src/mockMpc/types.js";
import type { Hex, UnsignedTx } from "src/signers/types.js";
import { addressFromNumber } from "src/utils/address.js";
import { describe, expect, it, vi } from "vitest";

const sampleTx: UnsignedTx = {
  to: addressFromNumber(100),
  value: 10n ** 15n,
  nonce: 0,
  gas: 21000n,
  maxFeePerGas: 10n ** 9n,
  maxPriorityFeePerGas: 10n ** 9n,
  chainId: 31337,
};

const signed = "0xsigned" as Hex;

function store(available?: ParticipantId[]) {
  return new CeremonyStore({
    sign: async () => signed,
    available,
  });
}

describe("CeremonyStore", () => {
  it("completes when all 3 participants are online", async () => {
    const ceremonies = store();
    const created = await ceremonies.create(sampleTx, "key-1");
    expect(created.status).toBe(CeremonyStatus.Completed);
    expect(created.signedTransaction).toBe(signed);
    expect(created.participantsCompleted).toBe(3);
    expect(created.threshold).toBe(THRESHOLD);
  });

  it.each<[ParticipantId[]]>([[[0, 1]], [[0, 2]], [[1, 2]]])(
    "completes with 2-of-3 participants %j",
    async (available) => {
      const ceremonies = store(available);
      const created = await ceremonies.create(sampleTx, "key-pair");
      expect(created.status).toBe(CeremonyStatus.Completed);
      expect(created.signedTransaction).toBe(signed);
      expect(created.participantsCompleted).toBe(2);
    },
  );

  it("fails when only 1 participant is online", async () => {
    const ceremonies = store([0]);
    const created = await ceremonies.create(sampleTx, "key-one");
    expect(created.status).toBe(CeremonyStatus.Failed);
    expect(created.error).toBe(CeremonyError.ThresholdNotMet);
    expect(created.signedTransaction).toBeUndefined();
  });

  it("returns the same request for a repeated idempotency key and payload", async () => {
    const ceremonies = store();
    const first = await ceremonies.create(sampleTx, "same-key");
    const second = await ceremonies.create(sampleTx, "same-key");
    expect(second.requestId).toBe(first.requestId);
    expect(second).toBe(first);
  });

  it("rejects a reused idempotency key with a different payload", async () => {
    const ceremonies = store();
    await ceremonies.create(sampleTx, "conflict-key");
    await expect(
      ceremonies.create({ ...sampleTx, nonce: 1 }, "conflict-key"),
    ).rejects.toBeInstanceOf(CeremonyConflictError);
  });

  it("shares one ceremony when the same key arrives while signing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signCalls = 0;
    const ceremonies = new CeremonyStore({
      sign: async () => {
        signCalls += 1;
        await gate;
        return signed;
      },
    });

    const first = ceremonies.create(sampleTx, "inflight-key");
    await vi.waitFor(() => expect(signCalls).toBe(1));
    const second = ceremonies.create(sampleTx, "inflight-key");
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(b.requestId).toBe(a.requestId);
    expect(a).toBe(b);
    expect(signCalls).toBe(1);
    expect(a.status).toBe(CeremonyStatus.Completed);
  });

  it("does not leave a reserved key when sign throws", async () => {
    let calls = 0;
    const ceremonies = new CeremonyStore({
      sign: async () => {
        calls += 1;
        if (calls === 1) throw new Error("sign exploded");
        return signed;
      },
    });
    await expect(ceremonies.create(sampleTx, "boom-key")).rejects.toThrow(/sign exploded/);
    const retry = await ceremonies.create(sampleTx, "boom-key");
    expect(retry.status).toBe(CeremonyStatus.Completed);
    expect(calls).toBe(2);
  });

  it("replays a completed ceremony when only gas or fees change", async () => {
    const ceremonies = store();
    const first = await ceremonies.create(sampleTx, "fee-key");
    const second = await ceremonies.create(
      { ...sampleTx, gas: 22000n, maxFeePerGas: 99n, maxPriorityFeePerGas: 1n },
      "fee-key",
    );
    expect(second).toBe(first);
  });

  it("retries a failed ceremony after participants recover", async () => {
    const ceremonies = store([0]);
    const failed = await ceremonies.create(sampleTx, "retry-key");
    expect(failed.status).toBe(CeremonyStatus.Failed);
    ceremonies.setAvailable([0, 1]);
    const retried = await ceremonies.create(sampleTx, "retry-key");
    expect(retried.status).toBe(CeremonyStatus.Completed);
    expect(retried.requestId).not.toBe(failed.requestId);
    expect(ceremonies.get(failed.requestId)?.status).toBe(CeremonyStatus.Failed);
  });

  it("fails when no participants are online", async () => {
    const ceremonies = store([]);
    const created = await ceremonies.create(sampleTx, "key-none");
    expect(created.status).toBe(CeremonyStatus.Failed);
    expect(created.error).toBe(CeremonyError.ThresholdNotMet);
    expect(created.signedTransaction).toBeUndefined();
  });
});
