# com7-lark-sync

One-way sync engine: **Com7 (MySQL) → LarkBase**.

Pushes raw sales rows from Com7 up to yearly Lark bases, keeps them up to date via
incremental sync, and can check/heal drift. Express control plane + MySQL worker
queue. Clean architecture — use-cases depend only on ports; MySQL/Lark adapters
are wired in `src/index.js` / `src/worker.js`.

| Store | Role |
|-------|------|
| MySQL **A** (Com7) | Source `itec` / `itec-today` — **read-only** |
| MySQL **B** (ops) | `sync_year`, `sync_partition`, `sync_mapping`, `sync_state`, `job_queue` |
| LarkBase | 1 base per year, ~250 partition tables (`itec_001`…) @ 20k records/table |

Lark app secrets are **per request** (`X-Lark-App-Id` / `X-Lark-App-Secret`), not in env.

---

## Quick start

```bash
npm install
cp .env.example .env          # fill COM7_* + OPS_* + LARK_BASE_DOMAIN
npm run migrate               # create ops schema on MySQL B
npm run preflight             # optional: verify Com7 schema assumptions
npm run dev                   # API on :3000
npm run worker                # required for /sync/full, hard-full, clear-partitions
```

```bash
curl http://localhost:3000/health
```

```bash
npm test
```

Node.js **>= 20**.

---

## Main scripts

| Script | Purpose |
|--------|---------|
| `npm start` / `npm run dev` | HTTP API (watch in `dev`) |
| `npm run worker` | Claim & run `job_queue` jobs |
| `npm run migrate` | Apply ops DB migrations |
| `npm run preflight` | Read-only Com7 schema checks before go-live |
| `npm test` | Unit tests (`node --test`) |

---

## Typical lifecycle

```text
1. Create empty Lark base for the year + share with the bot app
2. POST /base/init          → provision partition tables + write ops metadata
3. POST /sync/full          → enqueue backfill (needs worker)
4. GET  /sync/full/status   → watch progress
5. POST /sync/incremental   → ongoing sync on a schedule (UTime watermark)
```

Repair / rebuild when needed:

- `GET /sync/full/check` → `POST /sync/full/heal`
- `POST /sync/hard-full` — wipe year + re-backfill (`confirm: true`)
- `POST /sync/clear-partitions` — wipe year, no rebuild (`confirm: true`)

Auth (all routes except `/health`):

```http
X-Lark-App-Id: <APP_ID>
X-Lark-App-Secret: <APP_SECRET>
Content-Type: application/json
```

---

## Architecture (layout)

```text
src/
├── domain/                 # entities, ports, pure services (deriveKey, checksum, …)
├── application/use-cases/  # provision, full/incremental sync, check, heal, …
├── infrastructure/
│   ├── config/             # env, field schema
│   ├── database/           # pools, migrations, MySQL adapters
│   ├── lark/               # token cache + LarkGatewayHttp
│   └── web/                # Express app, routes, controllers, auth middleware
├── index.js                # API composition root
└── worker.js               # background job runner
```

**Sync path (simplified):**
read Com7 → reserve partition slots in ops → Lark `batch_create` / `batch_update`
→ write `sync_mapping` (`source_key` ↔ `lark_record_id`) → checkpoint / watermark.
Never fetch Lark records to resolve ids on the hot path.

---

## Docs

| Doc | Contents |
|-----|----------|
| [docs/sync-workflow.md](docs/sync-workflow.md) | End-to-end workflow (+ Lark APIs used) |
| [docs/api-overview.md](docs/api-overview.md) | What each HTTP endpoint does |
| [docs/api-reference.md](docs/api-reference.md) | Request / response / errors |
| [docs/deployment.md](docs/deployment.md) | Deploy at Com7, env, preflight |
| [docs/sync-architecture.md](docs/sync-architecture.md) | Design decisions & constraints |
| [docs/lark-base-v3-api-notes.md](docs/lark-base-v3-api-notes.md) | Lark shapes, rate limits, batch sizes |
| [docs/postman_collection.json](docs/postman_collection.json) | Postman collection |

---

## Repo

https://github.com/piiwpum/com7-sync-to-lark-base
