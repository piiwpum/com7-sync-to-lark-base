# com7-lark-sync

Com7 → LarkBase **one-way sync / reconciliation engine**. Pushes raw sales rows
from Com7 (MySQL) up to LarkBase and keeps them equal over time (push + diff +
heal). Built with **clean architecture** on Express + MySQL.

> Design & context: [docs/sync-architecture.md](docs/sync-architecture.md)

## Architecture

```
src/
├── domain/                      # business rules (no MySQL/Lark/Express knowledge)
│   ├── entities/                #   SyncYear, Partition, Mapping
│   ├── services/                #   deriveKey (identity), checksum  [WIP]
│   └── repositories/            #   ports: Source, Mapping, JobQueue, LarkGateway
├── application/use-cases/       # orchestration (depends only on ports)  [WIP]
├── infrastructure/              # frameworks & drivers
│   ├── config/env.js            #   env: MySQL A (read) + MySQL B (ops) + Lark
│   ├── database/                #   pools + migrations  [WIP]
│   ├── repositories/            #   MySQL/Lark adapters  [WIP]
│   └── web/                     #   Express control plane (/health, ...)
└── index.js                     # composition root (dependency injection)
```

**Dependency rule:** dependencies point inward. Use-cases depend only on the
repository *ports*; concrete MySQL/Lark adapters are injected at the composition
root (`index.js`).

## Data stores

| Store | Role |
|-------|------|
| MySQL **instance A** (Com7) | source `itec` / `daily_itec_temp` — **read-only** |
| MySQL **instance B** (ops)  | `sync_mapping` / `sync_partition` / `sync_state` / `job_queue` — durable |

## Getting started

```bash
npm install
cp .env.example .env      # fill in the two MySQL instances + Lark creds
npm run dev               # watch mode  (npm start for prod)
curl http://localhost:3000/health
```

## Status

Foundation in progress (Step 1: clean-architecture skeleton + `/health`).
See [docs/sync-architecture.md](docs/sync-architecture.md) §12 for the phase plan.
