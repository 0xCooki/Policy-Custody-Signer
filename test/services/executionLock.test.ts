import { ApiErrorCode } from "src/domain/types.js";
import {
  acquireExecution,
  isExecutionInFlight,
  releaseExecution,
  resetExecutionLock,
} from "src/services/executionLock.js";
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => {
  resetExecutionLock();
});

describe("executionLock", () => {
  it("refuses a second acquire until release", () => {
    const lock = acquireExecution("intent-1");
    expect(isExecutionInFlight("intent-1")).toBe(true);

    try {
      acquireExecution("intent-1");
      expect.unreachable("expected ExecutionInProgress");
    } catch (err) {
      expect(err).toMatchObject({ code: ApiErrorCode.ExecutionInProgress });
    }

    releaseExecution(lock);
    expect(isExecutionInFlight("intent-1")).toBe(false);
    const next = acquireExecution("intent-1");
    releaseExecution(next);
  });

  it("does not drop a newer holder on a stale release", () => {
    const first = acquireExecution("intent-1");
    releaseExecution(first);
    const second = acquireExecution("intent-1");

    releaseExecution(first);
    expect(isExecutionInFlight("intent-1")).toBe(true);
    try {
      acquireExecution("intent-1");
      expect.unreachable("expected ExecutionInProgress");
    } catch (err) {
      expect(err).toMatchObject({ code: ApiErrorCode.ExecutionInProgress });
    }

    releaseExecution(second);
    expect(isExecutionInFlight("intent-1")).toBe(false);
  });
});
