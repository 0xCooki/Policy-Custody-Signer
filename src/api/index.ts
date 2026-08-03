import { pathToFileURL } from "node:url";

import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { config } from "src/config.js";

const app = new Hono();

app.get("/health", (c) =>
  c.json({
    ok: true,
    signerBackend: config.signerBackend,
  }),
);

export { app };

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`listening on http://localhost:${info.port}`);
  });
}
