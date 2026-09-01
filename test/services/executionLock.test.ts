import { ApiErrorCode } from "src/domain/types.js";
import {
  acquireExecution,
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
    expect(() => acquireExecution("intent-1")).toThrow(
      expect.objectContaining({ code: ApiErrorCode.ExecutionInProgress }),
    );
    releaseExecution(lock);
    const next = acquireExecution("intent-1");
    releaseExecution(next);
  });

  it("does not drop a newer holder on a stale release", () => {
    const first = acquireExecution("intent-1");
    releaseExecution(first);
    const second = acquireExecution("intent-1");

    releaseExecution(first);
    expect(() => acquireExecution("intent-1")).toThrow(
      expect.objectContaining({ code: ApiErrorCode.ExecutionInProgress }),
    );

    releaseExecution(second);
    const third = acquireExecution("intent-1");
    releaseExecution(third);
  });
});
