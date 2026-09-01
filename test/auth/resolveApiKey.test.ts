import { resolveApiKey } from "src/auth/resolveApiKey.js";
import type { ApiKeysConfig } from "src/auth/types.js";
import { Role } from "src/domain/types.js";
import { describe, expect, it } from "vitest";

const apiKeys: ApiKeysConfig = {
  initiators: "dev-initiator-a, dev-initiator-b",
  approvers: "dev-approver-a, dev-approver-b",
  admins: "dev-admin-a, dev-admin-b",
};

describe("resolveApiKey", () => {
  it("resolves configured keys and rejects missing or unknown", () => {
    const cases = [
      ["dev-initiator-a", Role.Initiator],
      ["dev-initiator-b", Role.Initiator],
      ["dev-approver-a", Role.Approver],
      ["dev-admin-a", Role.Admin],
    ] as const;
    for (const [key, role] of cases) {
      expect(resolveApiKey(key, apiKeys)).toEqual({ role, actorId: key });
    }
    expect(resolveApiKey(undefined, apiKeys)).toBe(null);
    expect(resolveApiKey("", apiKeys)).toBe(null);
    expect(resolveApiKey("unknown", apiKeys)).toBe(null);
  });
});
