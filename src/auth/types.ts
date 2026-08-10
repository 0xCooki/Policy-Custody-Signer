import type { Role } from "src/domain/types.js";

// Using the API key as the id for the moment
export type AuthActor = {
  role: Role;
  actorId: string;
};

// strings can be a csv of keys
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
