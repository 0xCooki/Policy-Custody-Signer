// Runs before every test file (see vitest.config).
process.env.SIGNER_BACKEND ??= "local";
process.env.RPC_URL ??= "http://127.0.0.1:8545";
process.env.CHAIN_ID ??= "31337";
process.env.LOCAL_PRIVATE_KEY ??=
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
process.env.DATABASE_PATH ??= "./data/test-custody.db";
process.env.POLICY_ALLOWLIST ??= "0x00000000000000000000000000000000000000c8";
process.env.POLICY_MAX_VALUE ??= "1000000000000000000";
