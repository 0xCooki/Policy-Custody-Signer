import { ApiErrorCode } from "src/domain/types.js";
import { AppError } from "src/utils/errors.js";

const inFlight = new Set<string>();

export function acquireExecution(intentId: string): void {
  if (inFlight.has(intentId)) {
    throw new AppError(
      ApiErrorCode.ExecutionInProgress,
      `Intent ${intentId} is still being executed`,
    );
  }
  inFlight.add(intentId);
}

export function releaseExecution(intentId: string): void {
  inFlight.delete(intentId);
}

export function isExecutionInFlight(intentId: string): boolean {
  return inFlight.has(intentId);
}

/** Test helper: drop any leftover in-process claims. */
export function resetExecutionLock(): void {
  inFlight.clear();
}
