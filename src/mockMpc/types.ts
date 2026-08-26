import type { CeremonyStatus } from "src/signers/mockMpcProtocol.js";
import type { Hex } from "src/signers/types.js";

export {
  CeremonyStatus,
  fingerprintTx,
  type UnsignedTxJson,
  unsignedTxFromJson,
  unsignedTxToJson,
} from "src/signers/mockMpcProtocol.js";

export const CeremonyError = {
  ThresholdNotMet: "threshold_not_met",
  IdempotencyConflict: "idempotency_conflict",
  InvalidRequest: "invalid_request",
  Unauthorized: "unauthorized",
  NotFound: "not_found",
} as const;
export type CeremonyError = (typeof CeremonyError)[keyof typeof CeremonyError];

export type ParticipantId = 0 | 1 | 2;

export type Ceremony = {
  requestId: string;
  idempotencyKey: string;
  status: CeremonyStatus;
  fingerprint: string;
  participantsCompleted: number;
  threshold: number;
  signedTransaction?: Hex;
  error?: typeof CeremonyError.ThresholdNotMet;
};

export class CeremonyConflictError extends Error {
  readonly code = CeremonyError.IdempotencyConflict;

  constructor() {
    super(CeremonyError.IdempotencyConflict);
    this.name = "CeremonyConflictError";
  }
}

export class InvalidRequestError extends Error {
  readonly code = CeremonyError.InvalidRequest;

  constructor(message: string = CeremonyError.InvalidRequest) {
    super(message);
    this.name = "InvalidRequestError";
  }
}
