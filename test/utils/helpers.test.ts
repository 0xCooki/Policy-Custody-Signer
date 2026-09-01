import { ApiErrorCode, AuditEventType, Role } from "src/domain/types.js";
import { AppError } from "src/utils/errors.js";
import { auditEventToJson, intentAuditToJson, intentToJson } from "src/utils/json.js";
import { arrayFromCsv, extractApiKey } from "src/utils/string.js";
import { describe, expect, it } from "vitest";

describe("arrayFromCsv", () => {
  it("trims entries and drops empties", () => {
    expect(arrayFromCsv(" a, ,b ,")).toEqual(["a", "b"]);
    expect(arrayFromCsv("")).toEqual([]);
  });
});

describe("extractApiKey", () => {
  it("prefers x-api-key over Bearer", () => {
    expect(extractApiKey("Bearer from-auth", "from-header")).toBe("from-header");
  });

  it("reads a Bearer token and ignores other schemes", () => {
    expect(extractApiKey("Bearer secret", undefined)).toBe("secret");
    expect(extractApiKey("Basic secret", undefined)).toBeUndefined();
    expect(extractApiKey(undefined, undefined)).toBeUndefined();
  });
});

describe("AppError", () => {
  it("defaults the message to the code", () => {
    const err = new AppError(ApiErrorCode.NotFound);
    expect(err.message).toBe(ApiErrorCode.NotFound);
    expect(err.code).toBe(ApiErrorCode.NotFound);
  });
});

describe("intentToJson", () => {
  it("stringifies value", () => {
    expect(intentToJson({ id: "1", value: 10n })).toEqual({ id: "1", value: "10" });
  });
});

const apiKeys = {
  initiators: "dev-initiator",
  approvers: "dev-approver",
  admins: "dev-admin",
};

describe("intentAuditToJson", () => {
  it("omits actor, chain hashes, and approverId", () => {
    expect(
      intentAuditToJson({
        id: "evt-1",
        type: AuditEventType.IntentApproved,
        payload: { intentId: "intent-1", approverId: "dev-approver", quorumMet: true },
        actor: "dev-approver",
        timestamp: "2026-01-01T00:00:00.000Z",
        prevHash: "0xprev",
        eventHash: "0xhash",
      }),
    ).toEqual({
      id: "evt-1",
      type: AuditEventType.IntentApproved,
      payload: { intentId: "intent-1", quorumMet: true },
      timestamp: "2026-01-01T00:00:00.000Z",
    });
  });
});

describe("auditEventToJson", () => {
  it("keeps hashes, maps actor to role, and strips approverId", () => {
    expect(
      auditEventToJson(
        {
          id: "evt-1",
          type: AuditEventType.IntentApproved,
          payload: { intentId: "intent-1", approverId: "dev-approver", quorumMet: true },
          actor: "dev-approver",
          timestamp: "2026-01-01T00:00:00.000Z",
          prevHash: "0xprev",
          eventHash: "0xhash",
        },
        apiKeys,
      ),
    ).toEqual({
      id: "evt-1",
      type: AuditEventType.IntentApproved,
      payload: { intentId: "intent-1", quorumMet: true },
      role: Role.Approver,
      timestamp: "2026-01-01T00:00:00.000Z",
      prevHash: "0xprev",
      eventHash: "0xhash",
    });
  });

  it("returns a null role when the actor is not a configured key", () => {
    expect(
      auditEventToJson(
        {
          id: "evt-1",
          type: AuditEventType.IntentCreated,
          payload: { intentId: "intent-1" },
          actor: "rotated-key",
          timestamp: "2026-01-01T00:00:00.000Z",
          prevHash: null,
          eventHash: "0xhash",
        },
        apiKeys,
      ).role,
    ).toBeNull();
  });
});
