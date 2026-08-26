import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { config } from "src/config.js";
import { createMockMpcApp } from "src/mockMpc/api.js";
import { CeremonyStore, MOCK_MPC_DEV_KEY } from "src/mockMpc/ceremonies.js";
import type { Hex } from "src/signers/types.js";
import { privateKeyToAccount } from "viem/accounts";

const privateKey = (config.mockMpc.devPrivateKey || MOCK_MPC_DEV_KEY) as Hex;
const store = new CeremonyStore({ privateKey });
const app = createMockMpcApp({
  apiKey: config.mockMpc.apiKey,
  chainId: config.chainId,
  address: privateKeyToAccount(privateKey).address,
  store,
});

export { app };

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  serve({ fetch: app.fetch, port: config.mockMpc.port }, (info) => {
    console.log(`mock-mpc listening on http://localhost:${info.port}`);
  });
}
