import type { ApiKeysConfig, AuthActor } from "src/auth/types.js";
import { Role } from "src/domain/types.js";
import { arrayFromCsv } from "src/utils/string.js";

export function resolveApiKey(
  apiKey: string | undefined,
  apiKeys: ApiKeysConfig,
): AuthActor | null {
  if (apiKey === undefined || apiKey === "") return null;

  const initiatorKeys = arrayFromCsv(apiKeys.initiators);
  if (initiatorKeys.includes(apiKey)) {
    return { role: Role.Initiator, actorId: apiKey };
  }

  const approverKeys = arrayFromCsv(apiKeys.approvers);
  if (approverKeys.includes(apiKey)) {
    return { role: Role.Approver, actorId: apiKey };
  }

  const adminKeys = arrayFromCsv(apiKeys.admins);
  if (adminKeys.includes(apiKey)) {
    return { role: Role.Admin, actorId: apiKey };
  }

  return null;
}
