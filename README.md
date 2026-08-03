# Policy-Custody-Signer

Featured TypeScript Project: Policy-gated custody signer with HSM/MPC adapters, maker-checker approvals, and hash-chained audit.

## Setup

Requires **Node 25+** and **pnpm 11+**.

```bash
cp .env.example .env
pnpm install
pnpm test
pnpm dev
```

Health check: `GET http://localhost:3000/health`
