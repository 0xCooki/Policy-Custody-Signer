import type { ApiErrorCode, PolicyReason } from "src/domain/types.js";

export type AppErrorCode = ApiErrorCode | PolicyReason;

export class AppError extends Error {
  readonly code: AppErrorCode;

  constructor(code: AppErrorCode, message?: string) {
    super(message ?? code);
    this.name = "AppError";
    this.code = code;
  }
}
