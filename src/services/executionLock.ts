import { ApiErrorCode } from "src/domain/types.js";
import { AppError } from "src/utils/errors.js";

export type ExecutionLock = { readonly intentId: string };

const inFlight = new Map<string, ExecutionLock>();

export function acquireExecution(intentId: string): ExecutionLock {
  if (inFlight.has(intentId)) {
    throw new AppError(
      ApiErrorCode.ExecutionInProgress,
      `Intent ${intentId} is still being executed`,
    );
  }
  const lock: ExecutionLock = { intentId };
  inFlight.set(intentId, lock);
  return lock;
}

/** No-op unless `lock` is the current holder. A stale release cannot drop a newer claim. */
export function releaseExecution(lock: ExecutionLock): void {
  if (inFlight.get(lock.intentId) === lock) {
    inFlight.delete(lock.intentId);
  }
}

export function isExecutionInFlight(intentId: string): boolean {
  return inFlight.has(intentId);
}

/** Test helper: drop any leftover in-process claims. */
export function resetExecutionLock(): void {
  inFlight.clear();
}
