# Spec — Full Sync (Backfill per year) — P2

> ส่วนที่ 2 ใน 3 ของงานหลัก (Lark setup ✅ · **full sync ตามปี** ← สเปคนี้ · interval sync)
> วันที่: 2026-07-03 · สถานะ: design approved, รอ review ก่อนทำ plan

---

## 1. Goal & Scope

Backfill ข้อมูล `itec` ทั้งปีของ **หนึ่งปี** เข้า Lark base ที่ provision ไว้แล้ว (P1) — ตรงกับ **Flow A (Backfill)** ใน [../../sync-architecture.md](../../sync-architecture.md) §8

**ใน scope:**
- อ่าน `itec` ทั้งหมดของปีที่ระบุจาก Com7 (instance A) → เขียนเข้า Lark (250 partition ที่ provision ไว้แล้ว) → บันทึก mapping ลง MySQL (instance B)
- Manual trigger (คนสั่งเอง), ไม่ใช่ schedule

**นอก scope (phase อื่น):**
- Flow B (itec incremental หลัง midnight merge) — ต้องรู้คำตอบ Open Q#2 (physical delete) ก่อน
- Flow C/D (today_itec ทุก 15 นาที, daily clear)
- Reconciliation L1-L3 (P5) — รวมถึง**การตรวจจับ/แก้ duplicate ที่เกิดจาก crash ระหว่างเขียน** (ดู §8 ด้านล่าง)
- ปีที่ sync `done` แล้ว → เรียกซ้ำ = no-op (คืนสถานะเดิม) **ไม่มีกลไก "force re-scan"** ในสเปคนี้

---

## 2. ข้อมูลจริงที่ verify แล้วบน mock Com7 DB (2026-07-03)

เชื่อมสำรวจจริงที่ `10.2.50.79:3306/com7` (10M rows):

| เรื่อง | ผล |
|---|---|
| จำนวนแถว `itec` | 10,000,000 |
| ช่วงปี (`CrTime`, พ.ศ.) | 2559–2569 (= ค.ศ. 2016–2026), 11 ปี |
| **`SellBranch\|SellID\|RowNo` unique?** | ✅ **0 duplicate group ใน 10M แถว** — deriveKey() ปลอดภัย ไม่ต้องพึ่ง `CrTime` tiebreaker |
| NULL ใน key columns | ✅ ไม่มีเลย |
| `SellID` ข้ามสาขา | ✅ ไม่มี (1 SellID = 1 สาขาเสมอ) |
| **PRIMARY KEY บน `itec`** | ❌ **ไม่มี** — มีแค่ index `idx_itec_sell_row (SellID, RowNo)` (non-unique แต่ empirically unique) |
| index บน `CrTime` | ❌ ไม่มี — query กรองทีละปีต้อง scan+filter (ยอมรับได้ เพราะเป็น one-time ต่อปี) |
| `UTime == CrTime` | 100% ของ 10M แถว (mock ไม่ simulate การแก้ไข) → **Open Q#2 ยังตอบไม่ได้จาก mock**; ไม่ block สเปคนี้เพราะ backfill เป็น insert-only |
| `sale`, `sale_line` | ว่างเปล่า (0 แถว) — ไม่เกี่ยวข้อง |
| Column ที่ไม่ได้ push เข้า Lark | `DocRef`,`DocNo`,`InvNo`,`RowNo`,`Serial`,`SalesCreatedDate/Time`,`Cr Office ID/Name`,`Office Order ID/Name` — **`RowNo` ใช้เป็น identity key แต่ไม่ใช่ Lark field ที่มองเห็นได้** (เก็บอยู่ใน `sync_mapping.source_key` ที่เดียว) |

---

## 3. Architecture

```
POST /sync/full {year}                    (header: X-Lark-App-Id/Secret — เหมือนทุก route)
 └─ ตรวจ sync_year(year).status === 'complete'   → 400/404 ถ้ายังไม่ provision
 └─ enqueue job_queue (type='full_sync', year, payload={appId,appSecret})
      idempotent: มี job ready/claimed อยู่แล้วสำหรับปีนี้ → คืนอันเดิม ไม่ enqueue ซ้ำ
 └─ 202 { year, jobId, status }

GET /sync/full/status?year=N               (header เหมือนกัน แม้ไม่ได้ใช้ Lark — เพื่อ consistency §2.1 เดิม)
 └─ อ่าน job_queue (แถวล่าสุดของปีนั้น) + sync_state(scope=`full_sync:{year}`) → summary

Worker process (แยก process จริง: `node src/worker.js`)
 └─ loop: claim job ready (`FOR UPDATE SKIP LOCKED`) → mark claimed (+ claimed_at)
      └─ สร้าง LarkGateway จาก job.payload.{appId,appSecret} (tokenCache refresh เองได้ตลอด job)
      └─ loop chunk (200 แถว) จนกว่าจะหมดหรือ error:
           1. อ่าน chunk จาก Com7 (`SourceRepository.fetchItecChunk`) — keyset cursor (SellID,RowNo)
              resume จาก `sync_state.last_id` ถ้ามี (ครั้งแรก = คอลัมน์ว่าง เริ่มจากศูนย์)
           2. คำนวณ `source_key = deriveKey(row)` ต่อแถว
           3. จอง slot จาก partition ปัจจุบันของปีนั้น (atomic `fill_count` trick)
              — ถ้าช่องเหลือ < 200 → ตัดแบ่งจองคร่อม 2 partition
           4. แปลงแถว → Lark field values (`itecFieldSchema` + พ.ศ.→ค.ศ. + epoch ms)
           5. `batch_create` ไป Lark (≤200/batch, retry บน rate-limit — logic เดิมใน `LarkGatewayHttp`)
           6. เขียน `sync_mapping` (batch upsert) + อัป `sync_partition` (fill_count, first_*/last_* ถ้าเป็นแถวแรก/ล่าสุดของ partition)
           7. checkpoint `sync_state` (last_id = cursor ล่าสุดที่ทำสำเร็จ, last_run_at)
      └─ หมดแถว → mark job 'done' + **ล้าง `payload.appSecret`** ทิ้ง
      └─ error ที่กู้ไม่ได้ (เกิน retry) → mark 'dead' + ล้าง secret + log
```

---

## 4. `job_queue` schema change

เปลี่ยน column `source_keys` (JSON) → **`payload` (JSON)** — ใช้เก็บพารามิเตอร์เฉพาะของแต่ละ `type` (วันนี้ `full_sync` เก็บ `{appId, appSecret}`; job type อื่นในอนาคตเก็บรูปแบบอื่นได้) เพิ่ม column `claimed_at DATETIME NULL` (ไว้ดูว่า job ค้างนานแค่ไหน)

```sql
ALTER TABLE job_queue
  CHANGE COLUMN source_keys payload JSON NULL,
  ADD COLUMN claimed_at DATETIME NULL AFTER status;
```

**Security:** `payload.appSecret` มีความหมายแค่ตอน job ยัง `ready`/`claimed` — พอ `done`/`dead` แล้ว worker ต้อง**ล้างทิ้งทันที** (update `payload` ให้เหลือแค่ `{appId}` หรือ NULL ทั้ง field) ลดเวลาที่ secret ค้างอยู่ใน DB ให้เหลือแค่ช่วงที่ job กำลังรันจริง

---

## 5. Chunking / Pagination

- Cursor: **`(SellID, RowNo)`** — ใช้ index `idx_itec_sell_row` ที่มีอยู่จริง (ascending keyset pagination, ไม่ใช้ `OFFSET` เพราะช้าที่ scale 10M+)
- กรองปี: **แปลง CE→BE ก่อน query เสมอ** (`yearBE = yearCE + 543`) เพราะ `CrTime` ใน Com7 เก็บเป็น พ.ศ. ตรง ๆ
  ```sql
  SELECT * FROM itec
  WHERE CrTime >= '{yearBE}-01-01 00:00:00' AND CrTime < '{yearBE+1}-01-01 00:00:00'
    AND (SellID > ? OR (SellID = ? AND RowNo > ?))
  ORDER BY SellID, RowNo
  LIMIT 200;
  ```
- ไม่มี index บน `CrTime` → query นี้เป็น **index scan ทั้ง `idx_itec_sell_row` + filter `CrTime` รายแถว** (ทำครั้งเดียวต่อปีตอน backfill ยอมรับต้นทุนนี้ได้)

---

## 6. Field Transform

- ใช้ `ITEC_FIELD_SCHEMA` (41 fields, มีอยู่แล้วจาก P1) เป็น field list เป้าหมาย
- Datetime (`CrTime`, `UTime`): **พ.ศ.→ค.ศ. (−543 ปี)** แล้วแปลงเป็น **epoch ms** (Asia/Bangkok, ตามที่ verify ไว้ใน P0 §3.1)
- Number: parse เป็น JS `Number` (mysql2 คืน `DECIMAL` เป็น string by default — ต้อง parse ให้ครบ)
- Text: string ตรง ๆ, ค่า NULL/ว่าง → ส่งเป็น `null` (ตาม Lark cell-value rule)
- **Checksum:** `crc32` บน JSON ของ field values ที่แปลงแล้ว **เรียงตาม `ITEC_FIELD_SCHEMA` order เดียวกันเป๊ะ** (เพื่อให้ deterministic — ใช้เทียบตอน reconcile L2 ในอนาคต)

---

## 7. Partition Routing (atomic reservation)

- เติม partition **เรียงจากน้อยไปมาก** (`itec_001` ก่อนเสมอ) — ย้ายไปตัวถัดไปเมื่อ `fill_count = 50000` เต็มพอดี
- **"partition ปัจจุบัน" ไม่ได้เก็บแยกต่างหาก** — หาได้เสมอด้วย query `SELECT partition_no FROM sync_partition WHERE year=? AND fill_count < 50000 ORDER BY partition_no LIMIT 1` (ทำงานถูกทั้งตอนเริ่มใหม่และตอน resume หลัง worker ตาย)
- จองด้วย MySQL counter trick (§10 เดิม):
  ```sql
  UPDATE sync_partition SET fill_count = LAST_INSERT_ID(fill_count + :n)
  WHERE year=:y AND partition_no=:p;
  SELECT LAST_INSERT_ID();  -- ได้ fill_count ใหม่ → รู้ช่วง index ที่จองได้
  ```
- ถ้า chunk 200 แถวไม่พอดีกับที่เหลือของ partition ปัจจุบัน (`50000 - fill_count < 200`) → แบ่งจอง 2 ส่วน: ส่วนแรกเติมที่เหลือของ partition ปัจจุบันให้เต็ม, ส่วนที่เหลือจองที่ partition ถัดไป (คนละ Lark table → ยิงคนละ `batch_create`)
- `sync_partition.first_*`/`last_*` (จาก migration 006) อัปเดตตอนนี้: **แถวแรก** ที่เขียนเข้า partition (ตอน `fill_count` ขยับจาก 0) เขียน `first_*`; **ทุกครั้ง**ที่เขียนแถวใหม่เข้า partition นั้น อัป `last_*` ทับ

---

## 8. Idempotency / Resume — accepted risk (ชัดเจน ไม่ปิดบัง)

- **Resume หลัง worker ตาย:** ใช้ **checkpoint `sync_state.last_id`** (คือ cursor `(SellID,RowNo)` ล่าสุดที่ commit สำเร็จ) — เริ่มใหม่จากจุดนั้น ไม่ใช่ per-row existence check (เร็วกว่าที่ scale 10M+)
- **⚠️ Known edge case (ยอมรับ ไม่แก้ในสเปคนี้):** ถ้า worker ตายพอดี **หลัง** `batch_create` สำเร็จบน Lark **แต่ก่อน** commit `sync_mapping` + checkpoint → รอบถัดไปจะ retry chunk เดิม → **สร้างซ้ำได้สูงสุด 1 chunk (≤200 แถว)** บน Lark
  - เกิดยาก (ต้อง crash ตรงหน้าต่างแคบมาก ๆ)
  - การตรวจจับ/แก้ duplicate แบบนี้ = หน้าที่ของ **P5 (Reconciliation L1-L3)** ซึ่งอยู่ใน roadmap อยู่แล้ว **ไม่ทำในสเปคนี้**
  - เหตุผลที่ยอมรับได้ตอนนี้: severity ต่ำ (ข้อมูลซ้ำนิดหน่อย แก้ทีหลังได้) เทียบกับความซับซ้อนของการสร้าง pending-batch-verify mechanism แบบเต็มตอนนี้ (YAGNI)

---

## 9. Error Handling

| สถานการณ์ | จัดการ |
|---|---|
| ปียังไม่ provision (`sync_year` ไม่ complete) | `400`/`404` ตอน enqueue ไม่สร้าง job |
| Lark rate-limit (`800004135`/`1254291`) | retry+backoff (logic เดิมใน `LarkGatewayHttp`) |
| Source DB (Com7) อ่านไม่ได้ | job → `dead` หลัง retry ครบ, log ชัดเจน, operator enqueue ใหม่ได้ |
| Worker claim job แล้วตายไม่ mark เสร็จ | ยังไม่มี auto-reclaim ในสเปคนี้ (ดู §11 deferred) — `claimed_at` เก็บไว้ให้ operator เช็คด้วยตาก่อน |
| enqueue ซ้ำระหว่างมี job ready/claimed | คืน job เดิม ไม่สร้างซ้ำ (idempotent) |

---

## 10. Components (clean architecture)

| ชั้น | ไฟล์ | หน้าที่ |
|---|---|---|
| domain | `services/deriveKey.js` (ใหม่) | `deriveKey(row) → "SellBranch\|SellID\|RowNo"` |
| domain | `services/checksum.js` (ใหม่) | `crc32(orderedValues)` |
| domain | `services/transformItecRow.js` (ใหม่) | row → Lark field-value object (พ.ศ.→ค.ศ., type mapping ตาม `ITEC_FIELD_SCHEMA`) |
| domain (port) | `repositories/SourceRepository.js` (มีอยู่แล้ว) | `fetchItecChunk({year, afterCursor, limit})` — ใช้ตรงตามที่ stub ไว้ |
| domain (port) | `repositories/MappingRepository.js` (มีอยู่แล้ว, ปรับเล็กน้อย) | `reserveSlots({year,count}) → segments[{partitionNo, larkTableId, startIndex, count}]`, `saveMappings(mappings[])`, `getState(scope)`, `setState(scope, patch)` |
| domain (port) | `repositories/JobQueue.js` (มีอยู่แล้ว) | `enqueue`, `claim`, `complete`, `retry` — ใช้ตรงตามที่ stub ไว้ |
| domain entity | `entities/Mapping.js` (ปรับ) | เพิ่ม `baseId`, `larkTableId` ให้ตรง schema `sync_mapping` ปัจจุบัน |
| infra | `database/com7Pool.js` (ใหม่) | mysql2 pool อ่านอย่างเดียว instance A |
| infra adapter | `database/SourceRepositoryMysql.js` (ใหม่) | keyset query ตาม §5 |
| infra adapter | `database/MappingRepositoryMysql.js` (ใหม่) | `reserveSlots` (LAST_INSERT_ID trick + first/last update), `saveMappings` (batch upsert), `getState`/`setState` (`sync_state`) |
| infra adapter | `database/JobQueueMysql.js` (ใหม่) | `enqueue`/`claim` (`FOR UPDATE SKIP LOCKED`)/`complete`/`retry` บน `job_queue` |
| application | `use-cases/EnqueueFullSync.js` (ใหม่) | validate provisioned + enqueue idempotent |
| application | `use-cases/RunFullSyncJob.js` (ใหม่) | logic เต็มของ worker loop (§3) |
| application | `use-cases/GetFullSyncStatus.js` (ใหม่) | อ่าน job_queue + sync_state |
| infra web | routes/controller `POST /sync/full`, `GET /sync/full/status` | ต่อ use-case ผ่าน `larkAuth` middleware เดิม |
| infra web | `middlewares/larkAuth.js` (**ปรับเล็กน้อย**) | ปัจจุบันแนบแค่ `req.larkGateway` (token ที่ resolve แล้ว) — ต้องแนบ `req.larkAppId`/`req.larkAppSecret` (ดิบ) เพิ่มด้วย เพราะ `POST /sync/full` ต้องเอาไปเก็บใน `job_queue.payload` ให้ worker ใช้ refresh token เองได้ตลอด job (route อื่นที่ไม่ใช้ 2 field นี้ไม่กระทบ) |
| infra | `src/worker.js` (ใหม่) | composition root ของ worker — คนละ entrypoint จาก `src/index.js` |

**Migration ที่ต้องเพิ่ม:** `008_job_queue_payload.sql` (ALTER ตาม §4)

---

## 11. Out of scope / Deferred (ชัดเจน)

- Auto-reclaim stale/stuck job (`claimed` ค้างนาน) — operator เช็คด้วยตาก่อน
- Duplicate detection/heal จาก crash-window (§8) — รอ P5
- Force re-scan ปีที่ `done` แล้ว — ไม่มีปุ่มนี้ในสเปคนี้
- Multi-app sharding (Open Q#7 เดิม) — ยังใช้ 1 app/job; เร่งความเร็วเป็นเรื่องทีหลัง
- Flow B/C/D ทั้งหมด (incremental, daily) — phase ถัดไป

---

## 12. Testing

- **unit:** `deriveKey`, `checksum` (deterministic order), `transformItecRow` (พ.ศ.→ค.ศ., type mapping, null handling), partition-boundary-split logic ใน `RunFullSyncJob`, idempotent-enqueue ใน `EnqueueFullSync`, claim/complete ใน `JobQueueMysql` (fake pool เหมือนที่ทำกับ `YearRepositoryMysql`)
- **live verification** (ต้องทำก่อนถือว่าจบ เหมือนทุก phase ที่ผ่านมา): backfill ปีเล็ก ๆ (เช่น sub-range ไม่กี่พันแถว) จาก mock DB จริง เข้า Lark base ทดสอบจริง → เทียบจำนวน record บน Lark กับ MySQL `sync_mapping` ให้ตรงกัน → verify checksum/field values ถูกต้อง (โดยเฉพาะวันที่ พ.ศ.→ค.ศ.)
