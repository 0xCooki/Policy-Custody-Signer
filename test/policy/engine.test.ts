import fc from "fast-check";
import { PolicyReason } from "src/domain/types.js";
import { evaluateApprove, evaluateCreate } from "src/policy/engine.js";
import { addressFromNumber } from "test/helpers/json.js";
import { describe, expect, it } from "vitest";

const runs = 1000;
const initiatorId = "dev-initiator-a";
const approverIdA = "dev-approver-a";
const approverIdB = "dev-approver-b";
const allowed = addressFromNumber(200);
const maxValue = 10n ** 18n;
const policy = { maxValue, allowlist: [allowed], quorum: 2 };

describe("Engine", () => {
  it("rejects values over max", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: policy.maxValue + 1n }), (value) => {
        expect(evaluateCreate({ to: allowed, value }, policy)).toEqual({
          ok: false,
          reason: PolicyReason.ValueOverMax,
        });
      }),
      { numRuns: runs },
    );
  });

  it("rejects non-allowlisted recipients", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 2n ** 160n - 1n }).filter((n) => n !== 200n),
        (n) => {
          expect(evaluateCreate({ to: addressFromNumber(n), value: maxValue }, policy)).toEqual({
            ok: false,
            reason: PolicyReason.ToNotAllowed,
          });
        },
      ),
      { numRuns: runs },
    );
  });

  it("allows values at or under max to an allowlisted recipient", () => {
    fc.assert(
      fc.property(fc.bigInt({ max: policy.maxValue }), (value) => {
        expect(evaluateCreate({ to: allowed, value }, policy)).toEqual({ ok: true });
      }),
      { numRuns: runs },
    );
  });

  it("rejects self approval", () => {
    const result = evaluateApprove(
      {
        initiatorId,
        approverId: initiatorId,
        existingApproverIds: [approverIdB],
      },
      policy,
    );
    expect(result).toEqual({ ok: false, reason: PolicyReason.SelfApproval });
  });

  it("rejects duplicate approval", () => {
    const result = evaluateApprove(
      {
        initiatorId,
        approverId: approverIdB,
        existingApproverIds: [approverIdB],
      },
      policy,
    );
    expect(result).toEqual({ ok: false, reason: PolicyReason.DuplicateApproval });
  });

  it("leaves quorum unmet on the first of two approvals", () => {
    const result = evaluateApprove(
      { initiatorId, approverId: approverIdA, existingApproverIds: [] },
      policy,
    );
    expect(result).toEqual({ ok: true, quorumMet: false });
  });

  it("meets quorum on the second distinct approval", () => {
    const result = evaluateApprove(
      {
        initiatorId,
        approverId: approverIdA,
        existingApproverIds: [approverIdB],
      },
      policy,
    );
    expect(result).toEqual({ ok: true, quorumMet: true });
  });
});
