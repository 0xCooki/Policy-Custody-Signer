process.env.POLICY_QUORUM = "2";
process.env.API_KEY_APPROVERS = "dev-approver,dev-approver-b";
process.env.DATABASE_PATH = `./data/test-quorum-${Date.now()}.db`;

const { app } = await import("src/api/index.js");
const { publicClient } = await import("src/chain/client.js");
const { IntentStatus, PolicyReason } = await import("src/domain/types.js");
const { addressFromNumber } = await import("src/utils/address.js");
const { beforeAll, describe, expect, it } = await import("vitest");

const adminHeaders = { Authorization: "Bearer dev-admin" };
const initiatorHeaders = {
  Authorization: "Bearer dev-initiator",
  "content-type": "application/json",
};
const approverAHeaders = { Authorization: "Bearer dev-approver" };
const approverBHeaders = { Authorization: "Bearer dev-approver-b" };

describe("quorum > 1 flow (Anvil required)", () => {
  beforeAll(async () => {
    try {
      await publicClient.getBlockNumber();
    } catch {
      throw new Error("Anvil is required for this suite. Start it in another terminal: anvil");
    }
  });

  it("requires two distinct approvers before execute succeeds", async () => {
    const walletRes = await app.request("/wallets", { method: "POST", headers: adminHeaders });
    expect(walletRes.status).toBe(201);
    const wallet = await walletRes.json();

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
    const intent = await intentRes.json();
    expect(intent.status).toBe(IntentStatus.Pending);

    const firstApprove = await app.request(`/intents/${intent.id}/approve`, {
      method: "POST",
      headers: approverAHeaders,
    });
    expect(firstApprove.status).toBe(200);
    const afterFirst = await firstApprove.json();
    expect(afterFirst.quorumMet).toBe(false);
    expect(afterFirst.intent.status).toBe(IntentStatus.Pending);

    const earlyExec = await app.request(`/intents/${intent.id}/execute`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(earlyExec.status).toBe(400);

    const duplicate = await app.request(`/intents/${intent.id}/approve`, {
      method: "POST",
      headers: approverAHeaders,
    });
    expect(duplicate.status).toBe(403);
    expect(await duplicate.json()).toEqual({ error: PolicyReason.DuplicateApproval });

    const secondApprove = await app.request(`/intents/${intent.id}/approve`, {
      method: "POST",
      headers: approverBHeaders,
    });
    expect(secondApprove.status).toBe(200);
    const afterSecond = await secondApprove.json();
    expect(afterSecond.quorumMet).toBe(true);
    expect(afterSecond.intent.status).toBe(IntentStatus.Approved);

    const execRes = await app.request(`/intents/${intent.id}/execute`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(execRes.status).toBe(200);
    const body = await execRes.json();
    expect(body.intent.status).toBe(IntentStatus.Confirmed);
    expect(body.txHash).toMatch(/^0x[0-9a-fA-F]+$/);
  });
});
