import { config } from "src/config.js";
import { createPublicClient, http } from "viem";
import { foundry } from "viem/chains";

export const publicClient = createPublicClient({
  chain: foundry,
  transport: http(config.rpcUrl),
});
