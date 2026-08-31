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
    acquireExecution("intent-1");
    expect(isExecutionInFlight("intent-1")).toBe(true);

    try {
      acquireExecution("intent-1");
      expect.unreachable("expected ExecutionInProgress");
    } catch (err) {
      expect(err).toMatchObject({ code: ApiErrorCode.ExecutionInProgress });
    }

    releaseExecution("intent-1");
    expect(isExecutionInFlight("intent-1")).toBe(false);
    acquireExecution("intent-1");
    releaseExecution("intent-1");
  });
});
