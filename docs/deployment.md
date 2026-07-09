# Deployment Guide — com7-lark-sync ที่ฝั่ง Com7

เอกสารนี้อธิบายขั้นตอนการนำ service ไป deploy ที่ environment จริงของ Com7 โดยเปลี่ยนจาก
mock เป็นของจริง 2 อย่าง:

1. **Com7 source DB (MySQL instance A)** — mock → database ขายจริงของ Com7 (read-only)
2. **Ops store (MySQL instance B)** — local ของเรา → MySQL database ที่ provision บน infra ของ Com7

> ภาพรวมสถาปัตยกรรม: [sync-architecture.md](sync-architecture.md)

---

## 0. หลักการที่ทำให้ย้ายง่าย

Service ออกแบบตาม clean architecture — DB ทั้งสองตัวแยก connection pool และถูก inject
ที่ composition root (`src/index.js`, `src/worker.js`) ทั้งหมด **ไม่มี host/credential ฝัง
ในโค้ด** ทุกอย่างมาจาก env ([src/infrastructure/config/env.js](../src/infrastructure/config/env.js))

ผลคือ การ "สลับ DB" ในเชิงโค้ด = **แก้ env อย่างเดียว** งานจริงและความเสี่ยงเกือบทั้งหมด
อยู่ที่การ **ยืนยันว่า schema ของ Com7 จริงตรงกับที่โค้ดสมมติไว้** (ดู §3)

| Store | Role | ความเสี่ยงในการย้าย |
|-------|------|--------------------|
| MySQL A (Com7 source) | อ่าน `itec` / `itec-today` — read-only | **สูง** — ขึ้นกับ schema จริงของ Com7 |
| MySQL B (ops) | `sync_mapping` / `sync_partition` / `sync_state` / `job_queue` | **ต่ำ** — schema เราเป็นเจ้าของเอง |

---

## 1. Prerequisites

- Node.js **>= 20** (ดู `package.json` → `engines`)
- MySQL 2 ชุด ที่ service เข้าถึงได้ทาง network:
  - **A** — Com7 source (มี read-only user)
  - **B** — ops store (มีสิทธิ์ CREATE/ALTER/INSERT/UPDATE/DELETE เพราะเราจะ migrate + เขียน)
- Network reachability: host ที่รัน service ต้อง reach MySQL ทั้งสอง (firewall / VPC / VPN)
- Lark app credentials — **ไม่ต้องตั้งใน env** (ส่งมาต่อ request ผ่าน header
  `X-Lark-App-Id` / `X-Lark-App-Secret`) ตั้งแค่ `LARK_BASE_DOMAIN`

---

## 2. Environment variables

คัดลอกจาก `.env.example` แล้วเติมค่าจริง:

```bash
cp .env.example .env
```

```dotenv
PORT=3000
NODE_ENV=production

# --- MySQL A: Com7 source (READ-ONLY, ห้ามเขียน) ---
COM7_DB_HOST=<host จริงของ Com7>
COM7_DB_PORT=3306
COM7_DB_USER=<read-only user>
COM7_DB_PASSWORD=<...>
COM7_DB_NAME=<database name จริง>

# --- MySQL B: ops store (database ที่ provision บน infra ของ Com7) ---
OPS_DB_HOST=<host ของ ops DB>
OPS_DB_PORT=3306
OPS_DB_USER=<ops user>
OPS_DB_PASSWORD=<...>
OPS_DB_NAME=sync_ops

# --- Lark ---
# larksuite.com (สากล) หรือ feishu.cn (จีน) — เลือกให้ตรง tenant
LARK_BASE_DOMAIN=https://open.larksuite.com

# soft time budget ต่อ call ของ POST /base/init (ms)
BASE_INIT_BUDGET_MS=600000

# วัน "เริ่มนับ" ของ incremental sweep — ตั้งเป็นวันที่ deploy จริงที่ Com7
# (ไม่ใช่ค่า mock 2026-07-03) ข้อมูลก่อนหน้านี้ถือว่าไม่เคยตั้งใจส่งขึ้น Lark
INCREMENTAL_DEFAULT_SINCE=<YYYY-MM-DD 00:00:00 = วัน go-live>
INCREMENTAL_CHUNK_SIZE=1000
```

> ⚠️ `INCREMENTAL_DEFAULT_SINCE` เป็น **CE (ค.ศ.), Asia/Bangkok wall clock** — โค้ดจะแปลง
> เป็น พ.ศ. เองตอน query (ดู §3 ข้อ 5) อย่าใส่เป็นปี พ.ศ.

---

## 3. ⭐ Schema verification checklist (ฝั่ง Com7 source — ทำก่อน go-live เสมอ)

โค้ด hard-code สมมติฐานเกี่ยวกับ schema ของ Com7 ไว้ที่
[SourceRepositoryMysql.js](../src/infrastructure/database/SourceRepositoryMysql.js) และ
[itecFieldSchema.js](../src/infrastructure/config/itecFieldSchema.js)
ต้องตรวจทีละข้อกับ DB จริง **ก่อน** เปิดใช้งาน:

| # | สมมติฐานในโค้ด | ตรวจอย่างไร | ถ้าไม่ตรง แก้ที่ |
|---|----------------|------------|------------------|
| 1 | Table ชื่อ `itec` (historical) และ `itec-today` (วันนี้) | `SHOW TABLES LIKE 'itec%';` | `SourceRepositoryMysql.js:57-58` |
| 2 | 41 คอลัมน์ตรงชื่อ + ตัวพิมพ์ (CrTime, SellID, SellBranch, UTime, …) | `SHOW COLUMNS FROM itec;` เทียบกับ `RAW` ใน `itecFieldSchema.js` | `itecFieldSchema.js` |
| 3 | มีคอลัมน์ `RowNo` (ใช้ใน cursor + deriveKey แต่ **ไม่อยู่ใน field schema**) | `SHOW COLUMNS FROM itec LIKE 'RowNo';` | `SourceRepositoryMysql.js`, `deriveKey.js` |
| 4 | มี index `idx_itec_sell_row` บน `(SellID, RowNo)` | `SHOW INDEX FROM itec;` — ถ้าไม่มี cursor pagination = full scan (ช้ามากบน 10M rows) | schema ฝั่ง Com7 |
| 5 | `CrTime` / `UTime` เก็บเป็น **ปี พ.ศ. (+543), Bangkok wall clock** | `SELECT CrTime FROM itec LIMIT 1;` — ปีขึ้น 25xx = พ.ศ. / 20xx = ค.ศ. | `beYearRange` + `ceDatetimeToBeString` ใน `SourceRepositoryMysql.js` |
| 6 | `SellBranch\|SellID\|RowNo` เป็น unique identity | `SELECT SellBranch,SellID,RowNo,COUNT(*) c FROM itec GROUP BY 1,2,3 HAVING c>1 LIMIT 1;` (ต้องได้ 0 แถว) | `deriveKey.js` |
| 7 | DB user เป็น **read-only** (one-way, ห้ามเขียน source) | `SHOW GRANTS;` — ควรมีแค่ SELECT | privileges ฝั่ง Com7 |

**สองข้อที่พลาดแล้วเจ็บที่สุด:**
- **ข้อ 5 (พ.ศ./ค.ศ.)** — ถ้าจริงเป็น ค.ศ. แต่โค้ด +543 → query จะ **ไม่เจอข้อมูลเลยแบบเงียบ ๆ** (ไม่ error)
- **ข้อ 4 (index)** — ถ้าไม่มี → full sync ช้าจนใช้งานไม่ได้บนข้อมูลจริง

---

## 4. ขั้นตอน deploy

### 4.1 เตรียม ops store (instance B) — งานง่าย
Schema เราเป็นเจ้าของเอง มี migration 001–008 ใน
[src/infrastructure/database/migrations/](../src/infrastructure/database/migrations/)

```bash
# 1. ให้ Com7 provision MySQL database เปล่า 1 อัน (แยกจาก source DB)
# 2. ตั้ง OPS_DB_* ใน .env ให้ชี้ไปที่นั้น
# 3. รัน migration
npm ci
npm run migrate
```

ผลลัพธ์ที่คาดหวัง: `[migrate] applied N migration(s): ...` (รันซ้ำได้ = idempotent)

### 4.2 ยืนยัน source (instance A)
ทำ checklist §3 ให้ครบก่อนไปต่อ

### 4.3 Start service (web + worker — ต้องรัน **คู่กัน**)

```bash
npm start        # Express control plane (API)
npm run worker   # job worker — poll job_queue ทุก 5s
```

> **สำคัญ:** `full_sync` / `hard_full_sync` / `clear_partitions` เป็น background job — ถ้าไม่รัน worker
> งานจะค้างใน `job_queue` และไม่ถูกประมวลผล (ดู [worker.js](../src/worker.js))
> แนะนำให้แยกเป็น 2 process ภายใต้ process manager (systemd / pm2 / container 2 ตัว)

### 4.4 Smoke test

```bash
curl http://localhost:3000/health
# คาดหวัง: {"status":"ok","uptime":...,"opsDb":"ok"}
```

> หมายเหตุ: `/health` ตอนนี้ ping แค่ **ops DB (B)** เท่านั้น ยังไม่ได้ ping Com7 source (A)
> — ดู [health.js](../src/infrastructure/web/routes/health.js) การเชื่อม source DB จริง
> ให้ทดสอบด้วยการยิง full-sync/incremental บนปีที่มีข้อมูลจริงแทน

---

## 5. ลำดับ operational หลัง deploy

1. `POST /base/init` — สร้าง base/partition/field บน Lark สำหรับปีเป้าหมาย
2. `POST /sync/full` (หรือ `/sync/hard-full`) — push ข้อมูลย้อนหลังทั้งปีเข้า Lark (worker รัน)
3. `POST /sync/check` → `POST /sync/heal` — reconcile ส่วนที่หาย
4. `POST /sync/incremental` — เรียกเป็นรอบ (~ทุก 15 นาที) จาก external scheduler
   เพื่อ sweep เฉพาะแถวที่ `UTime` เปลี่ยนหลัง watermark

> รายละเอียด endpoint: [api-reference.md](api-reference.md) / [openapi.yaml](openapi.yaml)

---

## 6. Checklist ก่อน go-live

- [ ] ops DB provision + `npm run migrate` ผ่าน
- [ ] Schema verification §3 ครบทั้ง 7 ข้อ (โดยเฉพาะข้อ 4 index และข้อ 5 พ.ศ./ค.ศ.)
- [ ] `COM7_DB_*` ชี้ DB จริง + user เป็น read-only
- [ ] `LARK_BASE_DOMAIN` ตรง tenant (larksuite vs feishu)
- [ ] `INCREMENTAL_DEFAULT_SINCE` = วัน go-live จริง (CE, Bangkok)
- [ ] Network: service reach ทั้ง MySQL A และ B
- [ ] Timezone ของ host และ MySQL session สอดคล้อง Asia/Bangkok
- [ ] web (`npm start`) + worker (`npm run worker`) รันทั้งคู่ภายใต้ process manager
- [ ] `/health` = `{"status":"ok","opsDb":"ok"}`
- [ ] ทดสอบ `/base/init` + `/sync/full` บนปีที่มีข้อมูลจริง 1 ปีก่อนเปิดใช้เต็ม

---

## 7. Rollback / ความปลอดภัย

- Source (A) เป็น **read-only** — service ไม่มีทางเขียนทับข้อมูลขายของ Com7
- ทุก state ของ service อยู่ใน ops DB (B) — ถ้าต้อง reset ทำที่ B เท่านั้น ไม่กระทบ A
- Lark เป็นปลายทาง one-way — แก้/ลบฝั่ง Lark ได้ผ่าน `/base/remove-partitions`
  โดยจะเคลียร์ `sync_mapping` ของ partition ที่ลบให้ด้วย
