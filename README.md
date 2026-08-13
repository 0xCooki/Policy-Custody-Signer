# Policy-Custody-Signer

Featured TypeScript Project: Policy-gated custody signer with HSM/MPC adapters, maker-checker approvals, and hash-chained audit.

## Setup

Requires **Node 25+**, **pnpm 11+**, and **Foundry** (`anvil` on your `PATH`).

```bash
cp .env.example .env
pnpm install
```

Anvil is required for the gated signing flow and for `pnpm test` / `pnpm test:coverage`:

```bash
# terminal A
anvil

# terminal B
pnpm test
pnpm test:coverage
pnpm lint:check
pnpm typecheck
pnpm typecheck:tests
pnpm dev
```

### Flow

1. **Create intent** — `initiator` API key  
2. **Approve** — `approver` API key (maker ≠ checker; quorum from policy)  
3. **Execute** — `approver` or `admin` — LocalKey sign → broadcast → confirm  

Auth header: `Authorization: Bearer <key>` using keys from `.env` / `.env.example` (defaults: `dev-initiator`, `dev-approver`, `dev-admin`).

Policy (`POLICY_MAX_VALUE`, `POLICY_ALLOWLIST`, `POLICY_QUORUM`) is evaluated on create; destinations must be allowlisted.

Health check: `GET http://localhost:3000/health`

Reset the local SQLite file: `pnpm db:reset`

### SoftHSM (real PKCS#11)

SoftHSM keeps the private key in a PKCS#11 token (lab stand-in for a bank HSM). Production swaps the `.so` for a hardware HSM module.

```bash
# API + SoftHSM + Anvil
docker compose up --build

# Live SoftHSM signer tests (builds image, starts Anvil, runs SoftHSM vitest)
pnpm test:softhsm
```

Or on the host: install SoftHSM2, run `./scripts/init-softhsm.sh`, export the printed `SOFTHSM_*` / `SOFTHSM2_CONF` vars, set `SIGNER_BACKEND=softhsm`.

Default `pnpm test` stays on LocalKey and skips SoftHSM live cases unless `SOFTHSM_MODULE_PATH` points at a real module. Use `pnpm test:softhsm` for the Docker SoftHSM path.
