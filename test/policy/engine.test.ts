import fc from "fast-check";
import { evaluateApprove, evaluateCreate } from "src/policy/engine.js";
import { addressFromNumber } from "src/utils/address.js";
import { describe, expect, it } from "vitest";

const runs = 1000;
const initiatorId = "dev-initiator-a";
const approverIdA = "dev-approver-a";
const approverIdB = "dev-approver-b";
const existingApproverIds = [approverIdB];
const allowed = addressFromNumber(200);
const maxValue = 10n ** 18n;
const policy = { maxValue, allowlist: [allowed], quorum: 2 };

describe("Engine", () => {
  it("Fuzz: evaluateCreate rejects values over max", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: policy.maxValue + 1n }), (value) => {
        const result = evaluateCreate({ to: allowed, value: value }, policy);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("value_over_max");
      }),
      { numRuns: runs },
    );
  });

  it("Fuzz: evaluateCreate rejects non-allowlisted recipients", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 2n ** 160n - 1n }).filter((n) => n !== 200n),
        (value) => {
          const result = evaluateCreate({ to: addressFromNumber(value), value: maxValue }, policy);
          expect(result.ok).toBe(false);
          expect(result.reason).toBe("to_not_allowed");
        },
      ),
      { numRuns: runs },
    );
  });

  it("Fuzz: evaluateCreate allows values under max and allowlisted recipient", () => {
    fc.assert(
      fc.property(fc.bigInt({ max: policy.maxValue }), (value) => {
        const result = evaluateCreate({ to: allowed, value: value }, policy);
        expect(result.ok).toBe(true);
      }),
      { numRuns: runs },
    );
  });

  it("Unit: evaluateApprove rejects self approval", () => {
    const result = evaluateApprove(
      {
        initiatorId: initiatorId,
        approverId: initiatorId,
        existingApproverIds: existingApproverIds,
      },
      policy,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("self_approval");
  });

  it("Unit: evaluateApprove rejects duplicate approval", () => {
    const result = evaluateApprove(
      {
        initiatorId: initiatorId,
        approverId: approverIdB,
        existingApproverIds: existingApproverIds,
      },
      policy,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("duplicate_approval");
  });

  it("Unit: evaluateApprove allows first approval approval", () => {
    const result = evaluateApprove(
      { initiatorId: initiatorId, approverId: approverIdA, existingApproverIds: [] },
      policy,
    );
    expect(result.ok).toBe(true);
    expect(result.quorumMet).toBe(false);
  });

  it("Unit: evaluateApprove allows first second approval", () => {
    const result = evaluateApprove(
      {
        initiatorId: initiatorId,
        approverId: approverIdA,
        existingApproverIds: existingApproverIds,
      },
      policy,
    );
    expect(result.ok).toBe(true);
    expect(result.quorumMet).toBe(true);
  });
});
