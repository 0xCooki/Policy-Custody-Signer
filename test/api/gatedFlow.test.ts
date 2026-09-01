import { app } from "src/api/index.js";
import { verifyAuditChain } from "src/audit/verify.js";
import { publicClient } from "src/chain/client.js";
import { listAuditEvents } from "src/db/audit.js";
import { openDb } from "src/db/client.js";
import { updateIntentStatus } from "src/db/intents.js";
import { AuditEventType, IntentStatus } from "src/domain/types.js";
import {
  type ApproveJson,
  addressFromNumber,
  type ExecuteJson,
  type IntentJson,
  type ReconcileJson,
  readJson,
  type WalletJson,
} from "test/helpers/json.js";
import { beforeAll, describe, expect, it } from "vitest";

const adminHeaders = { Authorization: "Bearer dev-admin" };
const initiatorHeaders = {
  Authorization: "Bearer dev-initiator",
  "content-type": "application/json",
};
const approverHeaders = { Authorization: "Bearer dev-approver" };

describe("unsafe intent → sign → tx hash (Anvil required)", () => {
  beforeAll(async () => {
    try {
      await publicClient.getBlockNumber();
    } catch {
      throw new Error("Anvil is required for this suite. Start it in another terminal: anvil");
    }
  });

  it("POST wallet → intent → approve → execute returns a tx hash", async () => {
    const walletRes = await app.request("/wallets", { method: "POST", headers: adminHeaders });
    expect(walletRes.status).toBe(201);
    const wallet = await readJson<WalletJson>(walletRes);
    expect(wallet.address).toMatch(/^0x/);

    const intentRes = await app.request("/intents", {
      method: "POST",
      headers: initiatorHeaders,
      body: JSON.stringify({
        fromWalletId: wallet.id,
        to: addressFromNumber(200),
        value: (10n ** 15n).toString(),
      }),
    });
    expect(intentRes.status).toBe(201);
    const intent = await readJson<IntentJson>(intentRes);
    expect(intent.status).toBe(IntentStatus.Pending);

    const approveRes = await app.request(`/intents/${intent.id}/approve`, {
      method: "POST",
      headers: approverHeaders,
    });
    expect(approveRes.status).toBe(200);
    const approved = await readJson<ApproveJson>(approveRes);
    expect(approved.intent.status).toBe(IntentStatus.Approved);
    expect(approved.quorumMet).toBe(true);

    const execRes = await app.request(`/intents/${intent.id}/execute`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(execRes.status).toBe(200);
    const body = await readJson<ExecuteJson>(execRes);
    expect(body.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(body.intent.status).toBe(IntentStatus.Confirmed);
    expect(body.intent.txHash).toBe(body.txHash);

    const receipt = await publicClient.getTransactionReceipt({
      hash: body.txHash as `0x${string}`,
    });
    expect(receipt.status).toBe("success");

    const intentGet = await readJson<IntentJson>(
      await app.request(`/intents/${intent.id}`, { headers: initiatorHeaders }),
    );
    expect(intentGet.events?.map((e) => e.type)).toEqual([
      AuditEventType.IntentCreated,
      AuditEventType.IntentApproved,
      AuditEventType.SignRequested,
      AuditEventType.TxBroadcast,
      AuditEventType.TxConfirmed,
    ]);
    expect(intentGet.events?.every((e) => e.payload.intentId === intent.id)).toBe(true);
    expect(
      intentGet.events?.every((e) => !("actor" in e) && !("prevHash" in e) && !("eventHash" in e)),
    ).toBe(true);

    const events = listAuditEvents(openDb());
    expect(verifyAuditChain(events)).toBe(true);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        AuditEventType.IntentCreated,
        AuditEventType.IntentApproved,
        AuditEventType.SignRequested,
        AuditEventType.TxBroadcast,
        AuditEventType.TxConfirmed,
      ]),
    );
  });

  it("reconciles a Broadcast intent from the on-chain receipt after a crash window", async () => {
    const walletRes = await app.request("/wallets", { method: "POST", headers: adminHeaders });
    expect(walletRes.status).toBe(201);
    const wallet = await readJson<WalletJson>(walletRes);

    const intentRes = await app.request("/intents", {
      method: "POST",
      headers: initiatorHeaders,
      body: JSON.stringify({
        fromWalletId: wallet.id,
        to: addressFromNumber(200),
        value: (10n ** 15n).toString(),
      }),
    });
    expect(intentRes.status).toBe(201);
    const intent = await readJson<IntentJson>(intentRes);

    const approveRes = await app.request(`/intents/${intent.id}/approve`, {
      method: "POST",
      headers: approverHeaders,
    });
    expect(approveRes.status).toBe(200);

    const execRes = await app.request(`/intents/${intent.id}/execute`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(execRes.status).toBe(200);
    const executed = await readJson<ExecuteJson>(execRes);
    expect(executed.intent.status).toBe(IntentStatus.Confirmed);

    // Crash after broadcast: hash is on the row, receipt is on-chain, status never left Broadcast.
    updateIntentStatus(openDb(), intent.id, IntentStatus.Broadcast);

    const recRes = await app.request(`/intents/${intent.id}/reconcile`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(recRes.status).toBe(200);
    const reconciled = await readJson<ReconcileJson>(recRes);
    expect(reconciled.intent.status).toBe(IntentStatus.Confirmed);
    expect(reconciled.txHash).toBe(executed.txHash);

    const intentGet = await readJson<IntentJson>(
      await app.request(`/intents/${intent.id}`, { headers: initiatorHeaders }),
    );
    expect(intentGet.events?.filter((e) => e.type === AuditEventType.TxConfirmed)).toHaveLength(2);
    expect(verifyAuditChain(listAuditEvents(openDb()))).toBe(true);
  });
});
