import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { appendAuditEvent } from "src/audit/log.js";
import { authMiddleware, requireRole } from "src/auth/middleware.js";
import type { AuthEnv } from "src/auth/types.js";
import { config } from "src/config.js";
import { openDb } from "src/db/client.js";
import { createIntent, getIntent } from "src/db/intents.js";
import { createWallet, listWallets } from "src/db/wallets.js";
import { evaluateCreate } from "src/policy/engine.js";
import type { PolicyConfig } from "src/policy/types.js";
import { approveIntent } from "src/services/approveIntent.js";
import { executeIntent } from "src/services/executeIntent.js";
import { createSigner } from "src/signers/createSigner.js";
import type { Address } from "src/signers/types.js";
import { intentToJson } from "src/utils/json.js";

const app = new Hono<AuthEnv>();
const db = openDb();
const signer = createSigner();
const policyConfig: PolicyConfig = {
  maxValue: config.policy.maxValue,
  allowlist: config.policy.allowlist as Address[],
  quorum: config.policy.quorum,
};

app.get("/health", (c) =>
  c.json({
    ok: true,
    signerBackend: config.signerBackend,
  }),
);

// Creates the same wallet with a different id each call
app.post("/wallets", authMiddleware, requireRole("admin"), async (c) => {
  const address = await signer.getAddress();
  const wallet = createWallet(db, {
    id: randomUUID(),
    address,
    createdAt: new Date().toISOString(),
  });
  return c.json(wallet, 201);
});

app.get("/wallets", authMiddleware, requireRole("admin"), (c) => c.json(listWallets(db)));

// POST intents, body: { fromWalletId, to, value } where the value as string is in JSON
app.post("/intents", authMiddleware, requireRole("initiator"), async (c) => {
  const body = await c.req.json<{
    fromWalletId: string;
    to: Address;
    value: string;
  }>();
  const actor = c.get("actor");

  const decision = evaluateCreate({ to: body.to, value: BigInt(body.value) }, policyConfig);
  if (!decision.ok) {
    appendAuditEvent(db, {
      type: "PolicyRejected",
      payload: { reason: decision.reason, to: body.to, value: BigInt(body.value).toString() },
      actor: actor.actorId,
    });
    return c.json({ error: decision.reason }, 422);
  }

  const intent = createIntent(db, {
    id: randomUUID(),
    fromWalletId: body.fromWalletId,
    to: body.to,
    value: BigInt(body.value),
    asset: "ETH",
    initiatorId: actor.actorId,
    status: "pending",
    createdAt: new Date().toISOString(),
  });
  appendAuditEvent(db, {
    type: "IntentCreated",
    payload: { intentId: intent.id, to: body.to, value: BigInt(body.value).toString() },
    actor: actor.actorId,
  });

  return c.json(intentToJson(intent), 201);
});

app.get("/intents/:id", authMiddleware, (c) => {
  const intent = getIntent(db, c.req.param("id"));
  if (!intent) return c.json({ error: "not found" }, 404);
  return c.json(intentToJson(intent));
});

app.post("/intents/:id/approve", authMiddleware, requireRole("approver"), async (c) => {
  const actor = c.get("actor");
  try {
    const result = approveIntent(db, policyConfig, {
      intentId: c.req.param("id"),
      approverId: actor.actorId,
    });
    return c.json({
      intent: intentToJson(result.intent),
      quorumMet: result.quorumMet,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "approve failed";
    if (message.includes("not found")) return c.json({ error: message }, 404);
    if (message === "self_approval" || message === "duplicate_approval") {
      return c.json({ error: message }, 403);
    }
    return c.json({ error: message }, 400);
  }
});

app.post("/intents/:id/execute", authMiddleware, requireRole("approver", "admin"), async (c) => {
  const actor = c.get("actor");
  const intent = getIntent(db, c.req.param("id"));
  if (!intent) return c.json({ error: "not found" }, 404);
  try {
    const result = await executeIntent(db, signer, intent.id, actor.actorId);
    return c.json({ intent: intentToJson(result.intent), txHash: result.txHash });
  } catch (err) {
    const message = err instanceof Error ? err.message : "execute failed";
    return c.json({ error: message }, 404);
  }
});

export { app };

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`listening on http://localhost:${info.port}`);
  });
}
