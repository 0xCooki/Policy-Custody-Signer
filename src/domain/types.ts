import type { Address, Hex } from "src/signers/types.js";

export type Role = "initiator" | "approver" | "admin";

export type IntentStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "broadcast"
  | "confirmed"
  | "failed";

export type Wallet = {
  id: string;
  address: Address;
  createdAt: string;
};

export type TransferIntent = {
  id: string;
  fromWalletId: string;
  to: Address;
  valueWei: bigint;
  asset: "ETH";
  initiatorId: string;
  status: IntentStatus;
  createdAt: string;
};

export type Approval = {
  id: string;
  intentId: string;
  approverId: string;
  createdAt: string;
};

export type AuditEventType =
  | "IntentCreated"
  | "IntentApproved"
  | "PolicyRejected"
  | "SignRequested"
  | "TxBroadcast"
  | "TxConfirmed"
  | "TxFailed"
  | "ReconcileMismatch";

export type AuditEvent = {
  id: string;
  type: AuditEventType;
  payload: Record<string, unknown>;
  actor: string;
  timestamp: string;
  prevHash: Hex | null;
  eventHash: Hex;
};
