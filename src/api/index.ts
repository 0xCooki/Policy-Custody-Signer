import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { config } from "src/config.js";
import { openDb } from "src/db/client.js";
import { createIntent, getIntent } from "src/db/intents.js";
import { createWallet, listWallets } from "src/db/wallets.js";
import { executeIntent } from "src/services/executeIntent.js";
import { createSigner } from "src/signers/createSigner.js";
import type { Address } from "src/signers/types.js";
import { intentToJson } from "src/utils/json.js";

const app = new Hono();
const db = openDb();
const signer = createSigner();

app.get("/health", (c) =>
  c.json({
    ok: true,
    signerBackend: config.signerBackend,
  }),
);

// Creates the same wallet with a different id each call
app.post("/wallets", async (c) => {
  const address = await signer.getAddress();
  const wallet = createWallet(db, {
    id: randomUUID(),
    address,
    createdAt: new Date().toISOString(),
  });
  return c.json(wallet, 201);
});

app.get("/wallets", (c) => c.json(listWallets(db)));

// POST /intents  body: { fromWalletId, to, value } where the value as string is in JSON
app.post("/intents", async (c) => {
  const body = await c.req.json<{
    fromWalletId: string;
    to: Address;
    value: string;
  }>();
  const intent = createIntent(db, {
    id: randomUUID(),
    fromWalletId: body.fromWalletId,
    to: body.to,
    value: BigInt(body.value),
    asset: "ETH",
    initiatorId: "dev-initiator",
    status: "pending",
    createdAt: new Date().toISOString(),
  });
  return c.json(intentToJson(intent), 201);
});

app.get("/intents/:id", (c) => {
  const intent = getIntent(db, c.req.param("id"));
  if (!intent) return c.json({ error: "not found" }, 404);
  return c.json(intentToJson(intent));
});

app.post("/intents/:id/execute", async (c) => {
  const intent = getIntent(db, c.req.param("id"));
  if (!intent) return c.json({ error: "not found" }, 404);
  try {
    const result = await executeIntent(db, signer, intent.id);
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
