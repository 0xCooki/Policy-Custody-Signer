import type { Role } from "src/domain/types.js";

export type AuthActor = {
  role: Role;
  actorId: string;
};

export type ApiKeysConfig = {
  initiators: string;
  approvers: string;
  admins: string;
};

export type AuthEnv = {
  Variables: {
    actor: AuthActor;
  };
};
