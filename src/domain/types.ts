import type { Address, Hex } from "src/signers/types.js";

export const Role = {
  Initiator: "initiator",
  Approver: "approver",
  Admin: "admin",
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const IntentStatus = {
  Pending: "pending",
  Approved: "approved",
  Rejected: "rejected",
  Broadcast: "broadcast",
  Confirmed: "confirmed",
  Failed: "failed",
} as const;
export type IntentStatus = (typeof IntentStatus)[keyof typeof IntentStatus];

export const Asset = {
  Eth: "ETH",
} as const;
export type Asset = (typeof Asset)[keyof typeof Asset];

export const AuditEventType = {
  IntentCreated: "IntentCreated",
  IntentApproved: "IntentApproved",
  PolicyRejected: "PolicyRejected",
  SignRequested: "SignRequested",
  TxBroadcast: "TxBroadcast",
  TxConfirmed: "TxConfirmed",
  TxFailed: "TxFailed",
  ReconcileMismatch: "ReconcileMismatch",
} as const;
export type AuditEventType = (typeof AuditEventType)[keyof typeof AuditEventType];

export const PolicyReason = {
  ValueOverMax: "value_over_max",
  ToNotAllowed: "to_not_allowed",
  SelfApproval: "self_approval",
  DuplicateApproval: "duplicate_approval",
} as const;
export type PolicyReason = (typeof PolicyReason)[keyof typeof PolicyReason];

export const ApiErrorCode = {
  Unauthorized: "unauthorized",
  Forbidden: "forbidden",
  NotFound: "not_found",
  InvalidStatus: "invalid_status",
  AlreadyClaimed: "already_claimed",
  TxReverted: "tx_reverted",
  ReconcileMismatch: "reconcile_mismatch",
  TxPending: "tx_pending",
  ExecutionInProgress: "execution_in_progress",
} as const;
export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

export type Wallet = {
  id: string;
  address: Address;
  createdAt: string;
};

export type TransferIntent = {
  id: string;
  fromWalletId: string;
  to: Address;
  value: bigint;
  asset: Asset;
  initiatorId: string;
  status: IntentStatus;
  txHash?: Hex;
  createdAt: string;
};

export type Approval = {
  id: string;
  intentId: string;
  approverId: string;
  createdAt: string;
};

export type AuditEvent = {
  id: string;
  type: AuditEventType;
  payload: Record<string, unknown>;
  actor: string;
  timestamp: string;
  prevHash: Hex | null;
  eventHash: Hex;
};
