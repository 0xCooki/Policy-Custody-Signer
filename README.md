# Policy-Custody-Signer

Featured TypeScript Project: Policy-gated custody signer with HSM/MPC adapters, maker-checker approvals, and hash-chained audit.

## Setup

Requires **Node 25+**, **pnpm 11+**, and **Foundry** (`anvil` on your `PATH`).

```bash
cp .env.example .env
pnpm install
```

Anvil is required for the unsafe signing flow and for `pnpm test`:

```bash
# terminal A
anvil

# terminal B
pnpm test
pnpm dev
```

Health check: `GET http://localhost:3000/health`

Reset the local SQLite file: `pnpm db:reset`
