import { createMiddleware } from "hono/factory";
import { resolveApiKey } from "src/auth/resolveApiKey.js";
import type { AuthEnv } from "src/auth/types.js";
import { config } from "src/config.js";
import type { Role } from "src/domain/types.js";
import { extractApiKey } from "src/utils/string.js";

// AuthN: attach actor or 401
export const authMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  const apiKey = extractApiKey(c.req.header("authorization"), c.req.header("x-api-key"));
  const actor = resolveApiKey(apiKey, config.apiKeys);
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  c.set("actor", actor);
  await next();
});

// AuthZ: require role or 403
export function requireRole(...roles: Role[]) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const actor = c.get("actor");
    if (!roles.includes(actor.role)) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  });
}
