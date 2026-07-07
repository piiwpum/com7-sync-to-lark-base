# Com7 → LarkBase Sync — Architecture & Context

> Design/context doc — สรุปจากการคุยออกแบบ ยังไม่ลงมือ implement
> อัปเดตล่าสุด: 2026-07-03 (เปลี่ยน mapping store จาก Redis → **MySQL**, ล็อก key strategy + schema findings)

---

## 1. Mission

Server นี้คือ **reconciliation engine** ทำหน้าที่ sync ข้อมูลขายจากฝั่ง Com7 (MySQL)
ขึ้นไปเก็บบน **LarkBase** แบบ **one-way** (ไม่เขียนกลับ MySQL ต้นทาง) เพื่อให้ทีมเอาข้อมูลบน
Lark ไปทำ Lark Dashboard เอง

**หัวใจเดียว: ทำให้ข้อมูลบน Lark = ข้อมูลจริงฝั่ง Com7 ตลอดเวลา** (push + จับ diff + heal)

- **ไม่สนใจ** dashboard / aggregate — คนอื่น aggregate บน Lark เอง (ไม่ผ่าน server นี้)
- เอา **raw** ขึ้นไปตรง ๆ

---

## 2. แหล่งข้อมูล (Com7, MySQL — instance A, read-only)

| Table | รายละเอียด |
|---|---|
| `itec` | รายการขายราย item (1 record / 1 item line), historical ถึง **Day-1**, ~10M/ปี (ไม่เกิน 13.5M) ตั้งแต่ปี 2559 → รวม ~100M |
| `daily_itec_temp` | รายการขาย **เฉพาะวันปัจจุบัน** |

**Logic ฝั่ง Com7:** ทุกเที่ยงคืน `upsert` record ทั้งหมดใน `daily_itec_temp` กลับเข้า `itec`
แล้ว **ลบ** `daily_itec_temp`

- ปริมาณ: ~10M/ปี (ไม่เกิน 13.5M), ข้อมูลตั้งแต่ปี 2559
- ปัจจุบันมี **mock DB จาก schema จริง + mock data 100M record** ไว้ทดสอบแล้ว

### 2.1 Schema findings (จาก CSV schema จริง — ~53 คอลัมน์)

| เรื่อง | ข้อสรุป |
|---|---|
| **วันที่เป็น พ.ศ. (Buddhist Era)** | `2569-05-14` = พ.ศ. 2569 = ค.ศ. 2026 — ทุกคอลัมน์วันที่ (`CrTime`, `SalesCreatedDate`, `UTime`) เป็น พ.ศ. → **ต้องแปลง −543 ปี ก่อน push** เพราะ Lark datetime เก็บเป็น epoch millis (**P0 พิสูจน์แล้ว**: ส่ง พ.ศ. ดิบ → Lark เก็บปี 2569, ดู §3.1) |
| **`UTime` = updated_at** | ✅ ยืนยันแล้วว่า **ขยับทุกครั้งที่ record ถูกแก้** → ใช้เป็น watermark จับ change ได้ (ไม่ต้อง full-scan 100M) |
| **`CrTime` = created_at** | immutable → ใช้ **ตัดปี/เลือก base** (ดู Decision #9) |
| **PK ไม่มีประกาศชัด** | Com7 ไม่ยืนยัน PK และส่งข้อมูลจริงไม่มีกำหนด → เราไม่รอ ใช้ **surrogate key ที่เรา verify uniqueness เองบน mock** (ดู §6.1) |
| **soft-delete?** | มี `STATUS`, `is_return`, `is_tradein`, `is_unbrick` → การยกเลิก/คืน *น่าจะ* เป็นการเปลี่ยน flag (UTime ขยับ → จับได้) **ยังต้องยืนยันว่า Com7 ไม่ physical DELETE** (Open Q #2) |
| **ชื่อคอลัมน์มี space / `/` / `%`** | เช่น `MIN PRICE`, `GP / UNIT`, `GP %` → เวลา query ต้องครอบ backtick, เวลา provision Lark field ต้องเคาะกับคนเขียนสูตรว่าใช้ชื่อเป๊ะหรือ normalize |

---

## 3. ข้อจำกัดฝั่ง Lark

- 1 table ได้สูงสุด **50K record**
- 1 base ได้สูงสุด **300 table**
- **POC พบว่า** การ fetch record จาก Lark เพื่อหา `lark_record_id` **ช้ามาก** → ห้ามใช้ใน sync path

### 3.1 P0 verified บน Lark จริง (2026-07-03, Larksuite `sky-group.sg`, app bot)

| เรื่อง | ผลจริง | กระทบดีไซน์ |
|---|---|---|
| **record_id ordering** | `batch_create` คืน `record_id_list` **เรียงตาม input เป๊ะ** (200/200, 0 mismatch) | ✅ `deriveKey → record_id` mapping ปลอดภัย |
| **batch size cap** | **สูงสุด 200 rec/batch** (เกิน → `800010701`) | ⚠️ เดิมประเมิน 500/1000 **ผิด** — ใช้ 200 |
| **write rate limit** | `800004135 "OpenAPIBatchAddRecords limited"` = **per-app per-method** | ⚠️ **parallel ข้าม table ไม่ช่วย** (ยิง 4 พร้อม ผ่าน 1) |
| **sustained rate** | **~189 rec/s** (1 app, serial + retry) | → ETA backfill (ดูล่าง) |
| **transient conflict** | เจอเป็นครั้งคราวตอนยิงรัว → retry/delay หาย | ✅ job_queue retry เอาอยู่ |
| **datetime** | เก็บเป็น **epoch ms**, base tz = Asia/Bangkok; ส่ง epoch → โชว์ตรง | ต้องแปลง พ.ศ.→ค.ศ. + สร้าง base ด้วย `--time-zone Asia/Bangkok` |
| **พ.ศ. ดิบ** | ส่ง `"2569-..."` → Lark เก็บ **ปี 2569** (เพี้ยน +543) | ⚠️ **ต้อง −543 บังคับ** (พิสูจน์แล้ว) |
| **base access** | base ที่สร้าง manual → app เข้าไม่ได้ (`91403`) จนกว่าจะ **แชร์ base ให้ app** | ทุก base รายปีต้องแชร์ให้ sync app(s) ก่อน (runbook) |

**ETA backfill (จาก 189 rec/s, 1 app):**

| งาน | 1 app | 5 apps (sharding) |
|---|---|---|
| 40M (4 ปี) | ~59 ชม. (~2.5 วัน) | ~12 ชม. |
| 100M (10 ปี) | ~147 ชม. (~6 วัน) | ~29 ชม. |
| daily ~37K/วัน | **~3.3 นาที** ✅ | — |

- **daily/incremental sบายมาก** — ปัญหาอยู่ที่ **backfill ครั้งแรก** เท่านั้น
- **ทางเร่ง = multi-app sharding** (limit เป็น per-app → N app หมุนเขียน ≈ N×189) หรือขอ quota tier สูงจาก Lark
- แต่ละ app ในพูลต้องถูกแชร์เข้าทุก base ที่จะเขียน

### 3.2 Full sync v2 (2026-07-06): ย้าย batchCreate จาก base/v3 → bitable/v1

`§3.1` วัดจาก endpoint **`base/v3/bases/.../records/batch_create`** เท่านั้น — cap 200 เป็นข้อจำกัดของ endpoint นั้นโดยเฉพาะ ไม่ใช่ข้อจำกัดของ Lark ทั้งระบบ ยืนยันแล้วว่า endpoint **`bitable/v1/apps/.../records/batch_create`** (คนละตัวกัน, คนละ body format) ให้ throughput สูงกว่ามาก:

| เรื่อง | v3 (เดิม) | v1 (ปัจจุบัน, live-verified) |
|---|---|---|
| batch cap | 200 (`800010701`) | **1,000** (`1254104` ถ้าเกิน) — ยิงจริงผ่านครบ 1,000/1,000 |
| record ordering | เรียงตาม input (200/200) | เรียงตาม input เช่นกัน (**1,000/1,000, 0 mismatch**, ยืนยันด้วย self-identifying record) — bonus: response echo `fields` กลับมาด้วย เช็คซ้ำได้โดยไม่ต้อง fetch เพิ่ม |
| body format | flat `{fields:[...names], rows:[[values]]}` | array `{records:[{fields:{name:value}}]}` |
| rate-limit code | `800004135` (per-app per-method) | `1254290` (TooManyRequest) / `1254291` (write conflict, ใช้ code เดียวกับ v3) |

**ผลต่อ backfill:** `chunkSize` เปลี่ยนจาก 200 → 1,000 → throughput ต่อ request เพิ่ม 5 เท่า (ตัวเลข ETA ในตารางด้านบนซึ่งคำนวณจาก 189 rec/s ที่ 200/batch ควรพิจารณาใหม่ เพราะ round-trip ต่อ record ลดลงอย่างมาก แม้ sustained rate ต่อวินาทีจริงยังไม่ได้ re-measure ที่ batch size ใหม่นี้)

**โค้ดที่เปลี่ยน:** `LarkGatewayHttp.batchCreate`, `RunFullSyncJob` (chunkSize default + ไม่ต้องพึ่ง positional `fieldNames` อีกต่อไปเพราะ v1 ส่ง field object ตรง ๆ), `worker.js` (เอา `fieldNames` ออกจาก wiring)

---

## 4. Decisions ที่ล็อกแล้ว

| # | สรุป |
|---|---|
| 1 | Mission เดียว: ทำให้ Lark = source (ทิ้งเรื่อง dashboard/aggregate) |
| 2 | `today_itec` (daily) sync ทุก **15 นาที** |
| 3 | **1 Base / 1 ปี** — Base สร้าง manual แล้วส่ง `base_id` ให้ API |
| 4 | API ต้อง **สร้าง 270 partition table รอไว้เลย** (จำเป็น เพราะมีคนไปเขียนสูตร Lark manual ทั้ง 270 table) |
| 5 | Partition `itec_001..itec_270` — ใช้ **MySQL (instance B) เป็น pointer + record_id mapping** (ห้าม fetch จาก Lark) |
| 6 | `daily_itec_01..10` — ลบด้วย **server API** แต่ **ไม่มี cron**; Lark workflow เป็นตัว trigger ตามเวลาแล้วเรียก API เรา |
| 7 | เอา **raw** เข้า; aggregate ทำ manual บน Lark (ไม่เกี่ยวกับ server) |
| 8 | เพิ่มปี (ย้อนหลัง/ข้างหน้า) ได้ **โดยไม่แก้โค้ด** — แค่เพิ่ม row `{year, base_id}` แล้ว trigger |
| **9** | **ตัดปีด้วย `CrTime`** (immutable → record ไม่ย้าย base ตอนถูกแก้) |
| **10** | **Mapping/pointer/state store = MySQL 8.0** (instance แยกจาก Com7) — **ไม่ใช้ Redis** |
| **11** | **Queue = MySQL-as-queue (SKIP LOCKED)** ยุบรวมกับ `pending_batch` — ไม่มี Redis/BullMQ |
| **12** | **Identity key = `deriveKey()`** ซ่อนหลังฟังก์ชันเดียว + **collision guard** (ดู §6.1) |

**Capacity math:** 13.5M ÷ 50K = 270 table < 300 ✅ (เหลือ headroom ~30 table/base — ปีปัจจุบันมี daily 10 table รวมด้วย ~280 ค่อนข้างชิด)
⚠️ **เพดานจริง = 300 × 50K = 15M/ปี** ถ้าปีไหนแตะ ~14–15M+ base จะเต็ม → ยังไม่มี spill plan (ดู §10)

---

## 5. Architecture

```
        ┌────────── Control Plane (Express) ──────────┐
        │ POST /years {year, base_id}   → provision + backfill
        │ POST /daily/clear             ← Lark workflow trigger
        │ POST /reconcile/{year}        → verify + heal
        │ GET  /status                  → progress / drift report
        └─────────────────────────────────────────────┘
 MySQL (Com7) ──read──►  Workers ──batch──►  LarkBase API
 itec / daily_itec_temp     │  ▲              (year = 1 base)
 [instance A, read-only]    ▼  │
              MySQL (ops) [instance B] — 1 datastore, durable
              ├─ sync_mapping   (partition by year)   ← PK กัน collision
              ├─ sync_partition (pointer, LAST_INSERT_ID trick)
              ├─ sync_state     (watermark / lastsync / last index)
              └─ job_queue      (= pending_batch, SKIP LOCKED)
```

- **Express** = control plane (trigger / status / รับ trigger จาก Lark workflow)
- **Workers** = ตัวยิงจริง ดึงงานจาก `job_queue` (MySQL) มี concurrency + backoff + resume
- **MySQL (instance B)** = durable store ตัวเดียว: mapping + pointer + state + queue
- **ไม่มี Redis / Postgres / BullMQ** ในระบบ

---

## 6. MySQL schema (instance B)

```sql
-- ปี → base (Decision #3, #8: เพิ่มปี = insert row)
sync_year(year PK, base_id, status);

-- pointer + fill count (atomic reserve ด้วย LAST_INSERT_ID trick)
-- first_*/last_* = boundary record ของ partition (monitoring/debug, ดูช่วง
-- ข้อมูลที่ partition ครอบคลุมได้ทันทีโดยไม่ต้อง scan sync_mapping/Lark)
-- เขียนโดย backfill engine (P2, ยังไม่ implement) — NULL จนกว่าจะเริ่มเขียนจริง
sync_partition(
  year, partition_no, lark_table_id, fill_count,
  first_lark_record_id, first_source_key, first_cr_time,
  last_lark_record_id, last_source_key, last_cr_time,
  PRIMARY KEY (year, partition_no)
);

-- ★ mapping ตัวใหญ่สุด (~100M rows)
-- base_id/lark_table_id เก็บซ้ำ (denormalize) ตรงแถวเลย — hot path (flow B
-- incremental) จะได้ไม่ต้อง JOIN sync_year/sync_partition ทุกครั้งที่จะ
-- update/delete record บน Lark
sync_mapping(
  year           INT,
  base_id        VARCHAR(64),
  source_key     VARCHAR(64),   -- deriveKey(): SellBranch|SellID|RowNo(+CrTime)
  partition_no   SMALLINT,
  lark_table_id  VARCHAR(64),
  lark_record_id VARCHAR(32),
  checksum       INT UNSIGNED,  -- crc32 จับ source เปลี่ยน
  cr_time        DATETIME,      -- ตัดปี (immutable, ค.ศ. หลังแปลง)
  u_time         DATETIME,      -- watermark
  PRIMARY KEY (year, source_key)         -- ← collision guard ฟรี
) PARTITION BY LIST (year) (...);        -- 1 partition/ปี, drop/rebuild ทีละปี

-- daily (แทน today:map / today:ptr)
today_mapping(source_key PK, daily_table_no, lark_record_id, checksum);

-- watermark / lastsync / last index sync
sync_state(scope PK, last_utime DATETIME, last_id BIGINT, last_run_at DATETIME, status);

-- queue = durable intent log (idempotency §10) + งานที่ worker เคลม
job_queue(
  id BIGINT PK AUTO_INCREMENT,
  type, year, partition_no,
  source_keys JSON,            -- pk list ของ batch
  status ENUM('ready','claimed','done','dead'),
  attempts INT, run_after DATETIME, created_at DATETIME
);
```

**หมายเหตุ MySQL:**
- Native `PARTITION BY LIST (year)` ทำได้ — กติกา: unique key ทุกตัวต้องมีคอลัมน์ partition → PK `(year, source_key)` มี `year` แล้ว ✅
- รวม `lark_record_id` + `checksum` ต่อ row เดียว → point-lookup ด้วย PK เร็วพอสำหรับ sync path (ไม่ fetch Lark)

### 6.1 Identity key + Collision guard (Decision #12)

เราไม่รอ Com7 บอก PK — ต้องการแค่ key ที่ **(1) unique + (2) immutable** ซึ่ง **verify เองได้บน mock 100M**

```
deriveKey(row) = `${SellBranch}|${SellID}|${RowNo}`
   └─ ถ้า verify แล้วยังชน → เติม CrTime (immutable, ระดับ ms) เป็น tiebreaker
```

- ซ่อนหลัง **ฟังก์ชันเดียว** `deriveKey(row)` → เปลี่ยนสูตรทีหลังแก้ที่เดียว
- **Collision guard:** PK `(year, source_key)` เป็น UNIQUE → ถ้าเขียน key ซ้ำจาก row คนละตัว (fingerprint ต่าง) ให้ **alert + หยุด ไม่ทับ** → เดาผิดจะ *ตะโกน* ตั้งแต่ backfill รอบแรก ไม่เงียบจนข้อมูลเพี้ยน
- ⚠️ mock อาจ unique โดยบังเอิญ (random) → **collision guard คือตัวกันของจริงตอน prod** ไม่ใช่แค่ผล mock
- **ต้องรัน uniqueness check บน mock ก่อนลงมือ** (query ชุด §11.1)

---

## 7. Durability & data-layer notes

ย้ายมา MySQL แล้ว → ความเสี่ยง "in-memory หาย" ของ Redis **หายไปทั้งหมด**:

- **Durable/ACID โดยกำเนิด** — ไม่ต้อง mirror/AOF/RDB; backup + PITR (binlog) เป็นเรื่องมาตรฐาน
- **ไม่ RAM-bound** — 100M rows ≈ 15–25 GB disk (รวม index) ราคาถูก, ไม่ต้องเผื่อ RAM 16–24GB แบบเดิม
- **datastore เดียว** — mapping + pointer + state + queue อยู่ instance เดียว, transactional ข้ามกันได้
- ยังต้องทำ: backup schedule + ซ้อม restore, จูน connection pool (queue churn + mapping table ก้อนใหญ่บน DB เดียว → แยก schema/tablespace ได้ถ้าจำเป็น)

---

## 8. Sync Flows

### A. Backfill (ครั้งแรก / เพิ่มปีย้อนหลัง — trigger manual, ไม่แก้โค้ด)
1. รับ `{year, base_id}` → provision 270 itec + 10 daily table + fields (idempotent)
2. อ่าน MySQL ต้นทางเป็น chunk ตาม id/CrTime → **reserve slot จาก `sync_partition` (atomic)** → enqueue batch job
3. worker ยิง `batch_create` → Lark คืน `record_ids` ตามลำดับ → เขียน `sync_mapping` + checksum (ใน txn)
4. อัปเดต progress ใน `sync_state` (resume ได้ถ้า worker ตาย)

> ⚠️ สมมติฐาน "Lark คืน `record_ids` เรียงตาม input" **ต้อง verify บน API จริงใน P0** — ถ้าไม่จริง mapping ผูกผิดเงียบ ๆ

### B. itec incremental (หลัง midnight merge ฝั่ง Com7)
- หา row ที่ `UTime > sync_state.last_utime` (watermark)
  - `source_key` มีใน `sync_mapping` แล้ว → `batch_update`
  - ยังไม่มี → `batch_create` → route ตาม pointer

### C. today_itec ทุก 15 นาที
- query `daily_itec_temp` → เทียบ checksum กับ `today_mapping`
  - ใหม่ → create · เปลี่ยน → update · หาย → delete
- ยิงเฉพาะส่วนที่ diff → API load น้อยหลัง cycle แรก

### D. Daily clear (Lark workflow เรียก `POST /daily/clear`)
- อ่าน `record_ids` จาก `today_mapping` → `batch_delete` (async, คืน 202) → ล้าง `today_mapping`
- ต้อง **idempotent** (trigger ซ้ำต้องไม่พัง) + จับ ordering กับ flow B ให้ชัด (ดู §10)

---

## 9. Reconciliation — "ทำให้เท่ากัน" โดยไม่ fetch Lark

| ชั้น | เช็ค | อ่าน Lark? | ความถี่ |
|---|---|---|---|
| **L1 Count** | `count(source)` vs Lark table `total` (1 call/table ได้ total) | แค่ total (ถูก) | nightly |
| **L2 Source drift** | checksum source ปัจจุบัน vs `checksum` ใน `sync_mapping` | ไม่ต้อง | daily |
| **L3 Deep verify** | fetch record จริงเทียบ (เฉพาะ table ที่ L1/L2 แดง) | ต้อง (จำกัดวง) | on-demand |

- L1/L2 แดง → **enqueue heal อัตโนมัติ** (create/update/delete ส่วนต่าง) + alert
- เก็บ watermark (`last_id`, `last_utime`) ต่อ scope ใน `sync_state`
- **Delete detection:** ถ้า Com7 เป็น soft-delete (STATUS/is_return) → L2 จับได้; ถ้ามี physical DELETE ต้องมี layer เทียบ **pk-set** (source keys vs `sync_mapping` keys) ต่อ partition แบบ rotation (Open Q #2)

---

## 10. จุดวิศวกรรมที่ต้องออกแบบให้แน่น

- **Pointer + concurrency:** reserve slot แบบ atomic ด้วย MySQL counter trick
  `UPDATE sync_partition SET fill_count = LAST_INSERT_ID(fill_count + :n) WHERE ...; SELECT LAST_INSERT_ID();`
  + logic ตอน batch **คร่อม 2 partition** (partition เหลือ 30 ช่อง batch 500 → ตัดแบ่ง เพราะ Lark ยิงทีละ table)
  + ⚠️ ทุก worker ชน counter row เดียว = serialize → ให้ worker **จอง chunk ใหญ่ทีเดียว** ลด contention
- **Dual-write Lark ↔ MySQL:** call Lark (external, ไม่มี txn) แล้วค่อยเขียน mapping → กันด้วย pattern:
  `BEGIN → reserve slot + insert job/pending → COMMIT` แล้ว `call Lark → BEGIN write mapping + mark done → COMMIT`;
  crash กลางทาง → recovery scan `job_queue`/pending (จุดเดียวที่อาจต้องอ่าน Lark เฉพาะ partition นั้น, เกิดยาก)
- **Idempotency / กัน record ซ้ำ:** `batch_create` timeout แต่ Lark สร้างจริง → retry ได้ duplicate; กันด้วย write-ahead job + verify เฉพาะ partition ตอน recover
  - ⚠️ **ผลสมทบที่เจอตอน final review ของ full-sync (P2):** ถ้า worker crash ระหว่างช่วง `batchCreate` สำเร็จ แต่ checkpoint (`sync_state`) ยังไม่ถูกบันทึก → re-run job จะ (1) สร้าง Lark record ซ้ำ **และ** (2) เผา capacity ของ partition ทิ้งถาวร เพราะ `reserveSlots` เพิ่ม `fill_count` commit ไปแล้วตั้งแต่รอบที่ crash (รอบใหม่ต้อง `reserveSlots` เพิ่มอีกชุด) — ไม่ใช่แค่ record กำพร้า (ไม่มี mapping ชี้ถึง record แรก) แต่ partition capacity ก็หายไปถาวรด้วย ไม่ใช่สิ่งที่ P2 (full-sync) ต้องแก้ — ปล่อยเป็นงานของ P5/reconciliation phase
- **Midnight ordering (flow B/C/D):** รอบเที่ยงคืน Com7 merge+ลบ daily, flow B ยิง incremental, flow D clear daily — ต้องมี **state machine/lock ต่อปี** (MySQL `GET_LOCK()` หรือ row lock `FOR UPDATE`) freeze flow C ระหว่างหน้าต่าง midnight + นิยาม handoff C→B→D — **ยังไม่ออกแบบ**
- **Provisioning 270 table:** สร้าง field จาก schema จริงให้เป๊ะ (ชื่อ/ชนิด) เพราะสูตร manual ผูกกับ field เหล่านี้ + แปลง พ.ศ.→ค.ศ. ตอน map datetime
- **Capacity spill:** เพดาน 15M/ปี ถ้าเกินต้องมี "spill to secondary base" — ยังไม่ออกแบบ

---

## 11. ❓ Open questions / ข้อมูลที่ยังต้องขอ

| # | คำถาม | สถานะ |
|---|---|---|
| 1 | Schema / PK / date column / updated_at | ✅ **เคลียร์** — มี CSV, `UTime`=updated (ขยับจริง), ตัดปีด้วย `CrTime`, PK ใช้ surrogate `deriveKey()` |
| 2 | การแก้ historical: มี update/delete ย้อนหลังไหม (physical vs soft-delete) | ⏳ **ต้องเช็ค** — กระทบ delete-detection (§9) |
| 3 | ~~Redis infra~~ → **MySQL (instance B) infra** — spec, backup/PITR, HA | ⏳ ต้องยืนยัน |
| 4 | **Lark app quota** — write QPS + batch size | ✅ **เคลียร์** (§3.1): batch 200, ~189 rec/s/app, per-app limit, parallel ไม่ช่วย → เหลือ **ตัดสินใจ multi-app sharding** เพื่อเร่ง backfill |
| 5 | **Field naming** MySQL → Lark: ใช้ชื่อเป๊ะ (มี space/`/`/`%`) หรือ normalize? ใครเป็นเจ้าของ spec | ⏳ กระทบ provisioning |
| 6 | เลข "ปี" ใน config `{year, base_id}` = ค.ศ. หรือ พ.ศ.? | ⏳ เคาะเลขปี (TZ = Asia/Bangkok ✅ ยืนยันจาก §3.1; ตัดด้วย CrTime) |
| 7 | **จำนวน app ในพูล** (multi-app sharding) + ใครสร้าง/แชร์ base ให้ทุก app | ⏳ ขึ้นกับ ETA backfill ที่ยอมรับได้ |

### 11.1 Uniqueness check ต้องรันบน mock ก่อนลงมือ (verify §6.1)

```sql
-- ❶ SellID+Product ซ้ำไหม (สมมติฐานที่ "อาจพัง")
SELECT SellID, Product, COUNT(*) c FROM itec GROUP BY SellID, Product HAVING c>1 LIMIT 10;
-- ❷ SellID+RowNo ซ้ำไหม (ถ้าไม่มีผล = PK ที่ใช่)
SELECT SellID, RowNo, COUNT(*) c FROM itec GROUP BY SellID, RowNo HAVING c>1 LIMIT 10;
-- ❸ RowNo เดินจริงในบิลเดียวไหม
SELECT SellID, COUNT(*) lines, COUNT(DISTINCT RowNo) d FROM itec GROUP BY SellID HAVING lines>1 LIMIT 20;
-- ❹ SellID unique ข้ามสาขาไหม
SELECT SellID, COUNT(DISTINCT SellBranch) b FROM itec GROUP BY SellID HAVING b>1 LIMIT 10;
```

---

## 12. Phases

| Phase | งาน | สถานะ |
|---|---|---|
| **P0** | เคาะ open questions + verify PK uniqueness on mock + verify "record_ids เรียงตาม input" + Lark write throughput จริง | ✅ **เสร็จ** — ผล §3.1 |
| **P1 — Lark setup** | `POST /base/init` (provision 250 partition table + 41 field, idempotent+resumable) + `POST /base/remove-partitions` (+`dryRun`) + `GET /base/status` + MySQL write-through (`sync_year`/`sync_partition`) + MySQL schema §6 | ✅ **เสร็จ** (2026-07-03) — 250 partition/base (ไม่ใช่ 270, daily แยก base ต่างหาก — พักไว้คุยทีหลัง) |
| **P2** | Backfill engine (`deriveKey()`, pointer reserve, mapping, resume, batch, `job_queue`) | ⏳ ถัดไป — รอ mock Com7 DB เสร็จ |
| **P3** | today 15-min sync + `POST /daily/clear` | ⏳ |
| **P4** | itec incremental (midnight) + midnight state machine (§10) | ⏳ |
| **P5** | Reconciliation L1–L3 + auto-heal + status report | ⏳ |
| **P6** | Backup/PITR + runbook (recover mapping / rebuild ปี) | ⏳ |

### 12.1 P1 (Lark setup) — สิ่งที่ได้จริง

- **Endpoints:** `POST /base/init`, `POST /base/remove-partitions` (+`?dryRun=true`), `GET /base/status?year=N` — auth ผ่าน header (`X-Lark-App-Id`/`X-Lark-App-Secret`) ทุก route
- **MySQL instance B ใช้งานจริงแล้ว:** local MySQL 8.0 (Homebrew), user `sync` (least privilege), schema 5 ตารางตาม §6 (`today_mapping`/daily ยังไม่สร้าง — พักไว้), migration ผ่าน `.sql` files + `npm run migrate` (idempotent)
- **`sync_partition` write-through:** `/base/init` เขียน `partition_no → lark_table_id` ทุกตัวที่เจอบน Lark (ทั้งสร้างใหม่+ของเดิม) ในคำสั่งเดียว หลังลูป Lark เสร็จ — self-healing สำหรับ base ที่ provision ไปก่อนมี write-through; **bound เฉพาะช่วง `1..partitionCount`** (แก้บั๊กที่เจอจาก live test: table `itec_NNN` นอกช่วงไม่ควรถูกนับ)
- **`/base/status` อ่าน MySQL ล้วน ไม่ยิง Lark** — เร็ว/ถูก ตรงกับเป้าหมายที่ตั้งไว้ตอน discuss gap
- **Bug จริงที่เจอจาก live-test (แก้แล้ว):**
  1. `list-fields` (base/v3) cap ที่ 20 ไม่มี pagination → เปลี่ยนดีไซน์เป็น "table มีอยู่ = สมบูรณ์" (ไม่เช็ค field รายตัว, พึ่ง atomicity ของ createTable แทน)
  2. `list-tables` (base/v3) cap ที่ 20 ไม่มี pagination → เปลี่ยนไปใช้ `bitable/v1` แทน (ยืนยัน enumerate ได้ครบ + paginate จริง)
- **ยังไม่ทำ (deferred, ไม่ block P2):** daily base provisioning (พักไว้คุยว่าจำเป็นไหม), field-schema drift detection บน table เดิม (ยอมรับความเสี่ยง — ต้อง freeze field schema ก่อน provision จริง)

---

## 13. Tech stack / ทุนที่มีแล้ว

- **Node.js + Express (clean architecture)** — ดู [README.md](../README.md); domain/application/infrastructure แยกชัด, ports (`LarkGateway`, `YearRepository`, ฯลฯ) + adapters
- **Lark:** `LarkGatewayHttp` (base/v3 + `bitable/v1` สำหรับ list-tables) — auth ผ่าน header ต่อ request, token cache keyed by `app_id`
- **MySQL instance B (ops store) — ใช้งานจริงแล้ว:** local MySQL 8.0 (Homebrew), user `sync` (least privilege) บน `sync_ops`; schema §6 (`sync_year`, `sync_partition`, `sync_mapping`, `sync_state`, `job_queue`) ผ่าน migration (`npm run migrate`)
- **MySQL instance A (Com7 source):** ยังไม่ผูก — รอ mock DB (`10.2.50.79`) เสร็จ, แยก track จาก ops store
- **lark skills** (`lark-base` ฯลฯ) ในเครื่อง — ใช้ตรวจ/probe base ตอน dev
- **Test:** `node --test`, TDD ทุก use-case + live verification จริงบน Lark test base ก่อน merge ทุกครั้ง
