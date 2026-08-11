import { resolveApiKey } from "src/auth/resolveApiKey.js";
import type { ApiKeysConfig } from "src/auth/types.js";
import { Role } from "src/domain/types.js";
import { describe, expect, it } from "vitest";

const apiKeys: ApiKeysConfig = {
  initiators: "dev-initiator-a, dev-initiator-b, dev-initiator-c",
  approvers: "dev-approver-a, dev-approver-b, dev-approver-c",
  admins: "dev-admin-a, dev-admin-b, dev-admin-c",
};

describe("ResolveApiKey", () => {
  it("Returns null for missing or empty key", () => {
    expect(resolveApiKey(undefined, apiKeys)).toBe(null);
    expect(resolveApiKey("", apiKeys)).toBe(null);
  });

  it("Resolves each comma-separated initiator", () => {
    expect(resolveApiKey("dev-initiator-a", apiKeys)).toEqual({
      role: Role.Initiator,
      actorId: "dev-initiator-a",
    });
    expect(resolveApiKey("dev-initiator-b", apiKeys)).toEqual({
      role: Role.Initiator,
      actorId: "dev-initiator-b",
    });
    expect(resolveApiKey("dev-initiator-c", apiKeys)).toEqual({
      role: Role.Initiator,
      actorId: "dev-initiator-c",
    });
  });

  it("Resolves each comma-separated approver", () => {
    expect(resolveApiKey("dev-approver-a", apiKeys)).toEqual({
      role: Role.Approver,
      actorId: "dev-approver-a",
    });
    expect(resolveApiKey("dev-approver-b", apiKeys)).toEqual({
      role: Role.Approver,
      actorId: "dev-approver-b",
    });
    expect(resolveApiKey("dev-approver-c", apiKeys)).toEqual({
      role: Role.Approver,
      actorId: "dev-approver-c",
    });
  });

  it("Resolves each comma-separated admin", () => {
    expect(resolveApiKey("dev-admin-a", apiKeys)).toEqual({
      role: Role.Admin,
      actorId: "dev-admin-a",
    });
    expect(resolveApiKey("dev-admin-b", apiKeys)).toEqual({
      role: Role.Admin,
      actorId: "dev-admin-b",
    });
    expect(resolveApiKey("dev-admin-c", apiKeys)).toEqual({
      role: Role.Admin,
      actorId: "dev-admin-c",
    });
  });

  it("Returns null for unknown key", () => {
    expect(resolveApiKey("unknown", apiKeys)).toBe(null);
  });
});
