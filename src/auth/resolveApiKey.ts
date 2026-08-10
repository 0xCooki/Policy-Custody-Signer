import type { ApiKeysConfig, AuthActor } from "src/auth/types.js";
import { arrayFromCsv } from "src/utils/string.js";

export function resolveApiKey(
  apiKey: string | undefined,
  apiKeys: ApiKeysConfig,
): AuthActor | null {
  if (apiKey === undefined || apiKey === "") return null;

  // Initiators
  const initiatorKeys = arrayFromCsv(apiKeys.initiators);
  if (initiatorKeys.includes(apiKey)) {
    return { role: "initiator", actorId: apiKey };
  }

  // Approvers
  const approverKeys = arrayFromCsv(apiKeys.approvers);
  if (approverKeys.includes(apiKey)) {
    return { role: "approver", actorId: apiKey };
  }

  // Admins
  const adminKeys = arrayFromCsv(apiKeys.admins);
  if (adminKeys.includes(apiKey)) {
    return { role: "admin", actorId: apiKey };
  }

  return null;
}
