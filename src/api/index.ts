import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { appendAuditEvent } from "src/audit/log.js";
import { verifyAuditChain } from "src/audit/verify.js";
import { authMiddleware, requireRole } from "src/auth/middleware.js";
import type { AuthEnv } from "src/auth/types.js";
import { config } from "src/config.js";
import { listAuditEvents, listAuditEventsForIntent } from "src/db/audit.js";
import { openDb } from "src/db/client.js";
import { createIntent, getIntent } from "src/db/intents.js";
import { createWallet, getWallet, listWallets } from "src/db/wallets.js";
import {
  ApiErrorCode,
  Asset,
  AuditEventType,
  IntentStatus,
  PolicyReason,
  Role,
} from "src/domain/types.js";
import { evaluateCreate } from "src/policy/engine.js";
import type { PolicyConfig } from "src/policy/types.js";
import { approveIntent } from "src/services/approveIntent.js";
import { executeIntent } from "src/services/executeIntent.js";
import { reconcileIntent } from "src/services/reconcileIntent.js";
import { createSigner } from "src/signers/createSigner.js";
import type { Address } from "src/signers/types.js";
import { AppError } from "src/utils/errors.js";
import { auditEventToJson, intentAuditToJson, intentToJson } from "src/utils/json.js";

const app = new Hono<AuthEnv>();
const db = openDb();
const signer = createSigner();
const policyConfig: PolicyConfig = {
  maxValue: config.policy.maxValue,
  allowlist: config.policy.allowlist as Address[],
  quorum: config.policy.quorum,
};

function statusForAppError(err: AppError): 400 | 403 | 404 | 409 | 422 {
  switch (err.code) {
    case ApiErrorCode.NotFound:
      return 404;
    case PolicyReason.SelfApproval:
    case PolicyReason.DuplicateApproval:
      return 403;
    case ApiErrorCode.AlreadyClaimed:
    case ApiErrorCode.TxReverted:
    case ApiErrorCode.ReconcileMismatch:
    case ApiErrorCode.TxPending:
    case ApiErrorCode.ExecutionInProgress:
      return 409;
    case PolicyReason.ValueOverMax:
    case PolicyReason.ToNotAllowed:
      return 422;
    default:
      return 400;
  }
}

function errorBody(err: unknown, fallback: 400 | 500) {
  if (err instanceof AppError) return { json: { error: err.code }, status: statusForAppError(err) };
  return { json: { error: err instanceof Error ? err.message : "failed" }, status: fallback };
}

app.get("/health", (c) =>
  c.json({
    ok: true,
    signerBackend: config.signerBackend,
  }),
);

app.post("/wallets", authMiddleware, requireRole(Role.Admin), async (c) => {
  const address = await signer.getAddress();
  const wallet = createWallet(db, {
    id: randomUUID(),
    address,
    createdAt: new Date().toISOString(),
  });
  return c.json(wallet, 201);
});

app.get("/wallets", authMiddleware, requireRole(Role.Admin), (c) => c.json(listWallets(db)));

app.post("/intents", authMiddleware, requireRole(Role.Initiator), async (c) => {
  const body = await c.req.json<{
    fromWalletId: string;
    to: Address;
    value: string;
  }>();
  const actor = c.get("actor");

  if (!getWallet(db, body.fromWalletId)) {
    return c.json({ error: ApiErrorCode.NotFound }, 404);
  }

  const decision = evaluateCreate({ to: body.to, value: BigInt(body.value) }, policyConfig);
  if (!decision.ok) {
    appendAuditEvent(db, {
      type: AuditEventType.PolicyRejected,
      payload: { reason: decision.reason, to: body.to, value: BigInt(body.value).toString() },
      actor: actor.actorId,
    });
    const err = new AppError(decision.reason);
    return c.json({ error: err.code }, statusForAppError(err));
  }

  const intent = createIntent(db, {
    id: randomUUID(),
    fromWalletId: body.fromWalletId,
    to: body.to,
    value: BigInt(body.value),
    asset: Asset.Eth,
    initiatorId: actor.actorId,
    status: IntentStatus.Pending,
    createdAt: new Date().toISOString(),
  });
  appendAuditEvent(db, {
    type: AuditEventType.IntentCreated,
    payload: { intentId: intent.id, to: body.to, value: BigInt(body.value).toString() },
    actor: actor.actorId,
  });

  return c.json(intentToJson(intent), 201);
});

app.get("/intents/:id", authMiddleware, (c) => {
  const intent = getIntent(db, c.req.param("id"));
  if (!intent) return c.json({ error: ApiErrorCode.NotFound }, 404);

  const actor = c.get("actor");
  const allowed =
    actor.role === Role.Admin ||
    actor.role === Role.Approver ||
    (actor.role === Role.Initiator && intent.initiatorId === actor.actorId);
  if (!allowed) return c.json({ error: ApiErrorCode.NotFound }, 404);

  return c.json({
    ...intentToJson(intent),
    events: listAuditEventsForIntent(db, intent.id).map(intentAuditToJson),
  });
});

app.get("/audit", authMiddleware, requireRole(Role.Admin), (c) => {
  const events = listAuditEvents(db);
  return c.json({
    events: events.map((event) => auditEventToJson(event, config.apiKeys)),
    verified: verifyAuditChain(events),
  });
});

app.post("/intents/:id/approve", authMiddleware, requireRole(Role.Approver), async (c) => {
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
    const { json, status } = errorBody(err, 400);
    return c.json(json, status);
  }
});

app.post(
  "/intents/:id/execute",
  authMiddleware,
  requireRole(Role.Approver, Role.Admin),
  async (c) => {
    const actor = c.get("actor");
    const intent = getIntent(db, c.req.param("id"));
    if (!intent) return c.json({ error: ApiErrorCode.NotFound }, 404);
    try {
      const result = await executeIntent(db, signer, intent.id, actor.actorId);
      return c.json({ intent: intentToJson(result.intent), txHash: result.txHash });
    } catch (err) {
      const { json, status } = errorBody(err, 500);
      return c.json(json, status);
    }
  },
);

app.post("/intents/:id/reconcile", authMiddleware, requireRole(Role.Admin), async (c) => {
  const actor = c.get("actor");
  const intent = getIntent(db, c.req.param("id"));
  if (!intent) return c.json({ error: ApiErrorCode.NotFound }, 404);
  try {
    const result = await reconcileIntent(db, intent.id, actor.actorId);
    return c.json({
      intent: intentToJson(result.intent),
      ...(result.txHash !== undefined ? { txHash: result.txHash } : {}),
    });
  } catch (err) {
    const { json, status } = errorBody(err, 500);
    return c.json(json, status);
  }
});

export { app };

/* v8 ignore start */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`listening on http://localhost:${info.port}`);
  });
}
/* v8 ignore stop */
