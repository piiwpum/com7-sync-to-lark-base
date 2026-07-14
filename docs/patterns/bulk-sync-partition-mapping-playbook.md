# Playbook: Bulk Ingestion + Partitioning + Record Mapping

> คู่มือหลักการ (business + engineering) สำหรับงาน **ดันข้อมูลจำนวนมากจากระบบต้นทาง → ระบบปลายทางที่มีข้อจำกัด** แบบ one-way
> กลั่นจากงานจริง (Com7 → LarkBase sync) แต่เขียนแบบ **ไม่ผูกกับ tech เฉพาะ** เพื่อเอาไปใช้กับ project อื่น
> อ่านคู่กับโค้ดจริงใน `src/application/use-cases/` และ `docs/sync-architecture.md`

---

## 0. ปัญหาที่ playbook นี้แก้

คุณมีข้อมูล **จำนวนมาก** (ล้าน–ร้อยล้าน records) ในระบบ A ต้องเอาขึ้นระบบ B ที่:
- มี **ข้อจำกัดต่อ container** (1 ตาราง/collection เก็บได้ไม่เกิน N records)
- มี **rate limit** ต่อ API
- **ช้ามาก** ถ้าจะ query กลับมาถามว่า "record นี้อยู่ที่ไหน" (ห้ามใช้ในเส้นทางปกติ)
- เป็น **external system** ที่ไม่มี transaction ร่วมกับเรา (เขียนสำเร็จ/ล้มเหลว แยกจาก DB เรา)

เป้าหมาย: ทำให้ข้อมูลบน B = ข้อมูลจริงบน A **ตลอดเวลา** พร้อมกู้คืนได้เมื่อพัง

---

## 1. หลักการภาพรวม (Business Principles)

| # | หลักการ | เหตุผล |
|---|---|---|
| P1 | **One-way, ปลายทางเป็นแค่กระจกเงา** | ไม่เขียนกลับ A → ตัดปัญหา conflict/2-way sync ทิ้งทั้งหมด ปลายทางพังก็ rebuild จากต้นทางได้เสมอ |
| P2 | **Idempotent ทุกจุด** | ทุก operation ต้องยิงซ้ำได้โดยไม่พัง (retry, สั่งซ้ำโดยพลาด, resume หลัง crash) |
| P3 | **ยอม duplicate ดีกว่ายอมข้อมูลหาย** | ข้อมูลซ้ำ = ตรวจเจอ + ลบทีหลังได้ / ข้อมูลหาย = กู้ไม่ได้ถ้าไม่รู้ว่าหาย |
| P4 | **แยก "งานที่ใช้เวลานาน" ออกจาก "การรับคำสั่ง"** | คำสั่งควรจบเร็ว (คืน job id) งานจริงวิ่งเบื้องหลังเป็นชั่วโมงได้ |
| P5 | **มี mapping store เป็น source of truth ของ "record นี้อยู่ที่ไหนบนปลายทาง"** | ห้ามพึ่ง query ปลายทาง ต้องจำเองใน DB เรา |
| P6 | **Verify สมมติฐานกับระบบจริง ก่อนลงมือ** | limit/behavior ที่เขียนใน docs มักผิด — ยิงจริงวัดเอง (ดู §7) |
| P7 | **มีเส้น reconciliation (ตรวจ + ซ่อม) แยกต่างหาก** | ระบบ dual-write ยังไงก็ drift ได้ ต้องมีเครื่องมือหาและซ่อมความต่าง |

---

## 2. Bulk Ingestion — เครื่องยนต์ดันข้อมูล

### 2.1 Architecture: Worker + Job Queue (ไม่ใช่ HTTP polling)

```
Client ──POST /sync──► Control Plane (HTTP)  ──enqueue──►  Job Queue (DB)
                          (คืน job id ทันที)                    │
                                                          claim │ (SKIP LOCKED)
                                                                ▼
                          Source DB ──read──►  Worker (process แยก)  ──batch write──►  Target
```

**ทำไมต้องแยก process:** งาน backfill 1 ปีอาจรัน **หลายชั่วโมง** — เกิน lifetime ของ HTTP request มาก ถ้าฝังใน HTTP handler จะ timeout / ผูกชีวิตงานไว้กับ web server

**Job Queue บน DB (ไม่ต้องมี Redis/Kafka ถ้ายังไม่จำเป็น):**
- ตาราง `job_queue(id, type, payload, status, attempts, run_after, claimed_at)`
- Worker `claim` ด้วย `SELECT ... WHERE status='ready' AND run_after <= NOW() FOR UPDATE SKIP LOCKED`
  → หลาย worker แย่งงานพร้อมกันได้โดยไม่ชนกัน (MySQL 8+/Postgres)
- Status: `ready → claimed → done | dead` (dead = retry ครบแล้วยังไม่ผ่าน)

### 2.2 Chunking + Keyset Cursor (ห้ามใช้ OFFSET)

ดึงต้นทางทีละ chunk ด้วย **keyset pagination** ตาม index ที่มีจริง:

```sql
-- ✅ keyset: เร็วคงที่ ไม่ว่าจะหน้าไหน
WHERE (key1 > :lastKey1 OR (key1 = :lastKey1 AND key2 > :lastKey2))
ORDER BY key1, key2 LIMIT :chunkSize

-- ❌ OFFSET: ยิ่งลึกยิ่งช้า (ต้อง scan ทิ้งทุกแถวก่อนหน้า)
ORDER BY ... LIMIT :chunkSize OFFSET :n
```

> **บทเรียน:** ใช้ index ที่ตารางต้นทาง**มีจริง** เป็น cursor แม้มันจะไม่ใช่ PK ก็ตาม (ตารางจริงมักไม่มี PK ประกาศชัด)

### 2.3 Checkpoint / Resume — เขียน checkpoint **เป็นลำดับสุดท้ายเสมอ**

ลำดับต่อ 1 chunk (**สำคัญมาก จำลำดับนี้**):

```
1. fetch chunk จากต้นทาง (ตาม checkpoint เดิม)
2. reserve slot บนปลายทาง (จองที่ — ดู §3)
3. write เข้าปลายทาง (batch)
4. write mapping ลง DB เรา
5. write checkpoint (cursor ล่าสุด)  ◄── ลำดับสุดท้ายเสมอ
```

**ทำไม checkpoint ต้องท้ายสุด (P3):**
- crash หลัง step 3 แต่ก่อน step 5 → resume จะดึง chunk **เดิม** ซ้ำ → เกิด **duplicate** (ยอมรับได้ ตรวจ/ลบได้)
- ถ้าสลับให้เขียน checkpoint **ก่อน** เขียนปลายทาง → crash ตรงกลาง → checkpoint ขยับไปแล้วแต่ข้อมูลไม่เคยขึ้นปลายทาง → **ข้อมูลหายถาวร** (แย่กว่า)

> เก็บ checkpoint เป็น JSON (`{key1, key2}`) ใน state table แยก scope ต่องาน เช่น `sync:2021`

### 2.4 Rate Limit + Retry

- ห่อ write call ด้วย retry-on-rate-limit + exponential backoff (`sleep(base * (attempt+1))`)
- **แยก error ให้ออก:** transient (rate limit, network) → retry ได้ / deterministic (validation, payload ผิด) → retry เท่าไหร่ก็ไม่ผ่าน อย่า retry ให้ตายเปล่า
- Job-level retry: `attempts++` + `run_after = now + delay`; เกิน `maxAttempts` → `dead`

---

## 3. Partitioning — เมื่อปลายทางจำกัดขนาดต่อ container

### 3.1 Capacity Math ต้องคำนวณก่อน

```
records ต่อปี ÷ ขนาดสูงสุดต่อ partition = จำนวน partition ที่ต้องการ
ต้อง ≤ เพดาน partition ต่อ container ของปลายทาง (มี headroom เผื่อ)
```

> **จับเพดานจริงให้เจอ:** ถ้าปีไหนข้อมูลแตะเพดาน (เช่น 15M/ปี ที่ 50K×300 table) ต้องมี **spill plan** ไว้ล่วงหน้า

### 3.2 Pre-provision + Denormalize Pointer

- **สร้าง partition รอไว้ล่วงหน้าทั้งหมด** (ไม่สร้างระหว่างวิ่ง) — โดยเฉพาะถ้ามีคนอื่นต้องไปผูก schema/สูตรกับ partition พวกนั้น
- เก็บ `partition → target_container_id` ใน pointer table
- **Denormalize** `container_id`/`partition_no` ลงบน mapping row ทุกแถว → hot path (update/delete รายตัว) ไม่ต้อง JOIN

### 3.3 Atomic Slot Reservation

จองที่แบบ atomic ก่อนเขียนจริง กัน worker หลายตัวแย่ง slot กัน:

```sql
-- row lock (อ่านง่าย, single/low-contention worker)
BEGIN;
SELECT partition_no, fill_count FROM partition
  WHERE year=? AND fill_count < :CAP ORDER BY partition_no LIMIT 1 FOR UPDATE;
UPDATE partition SET fill_count = fill_count + :n WHERE ...;
COMMIT;

-- หรือ counter trick (contention สูง)
UPDATE partition SET fill_count = LAST_INSERT_ID(fill_count + :n) WHERE ...;
```

### 3.4 Segment Splitting (chunk คร่อม partition)

ถ้า partition ปัจจุบันเหลือ 30 ช่อง แต่ chunk มี 200 rows → **ตัดแบ่งเป็นหลาย segment** เพราะเขียนปลายทางทีละ container:

```
reserveSlots(count=200) → [
  { partition: 4, startIndex: 49970, count: 30 },  // เติม partition 4 จนเต็ม
  { partition: 5, startIndex: 0,     count: 170 }, // ล้นไป partition 5
]
```

แล้ว loop เขียนปลายทางทีละ segment (คนละ container)

---

## 4. Record Mapping กับ PK/Identity

### 4.1 Identity Key — ซ่อนหลังฟังก์ชันเดียว

```
deriveKey(row) = `${col1}|${col2}|${col3}`   // stable, immutable
```

- ถ้าต้นทาง **ไม่มี PK ชัดเจน** → สร้าง **surrogate key** จาก columns ที่รวมกันแล้ว unique
- **ต้อง verify uniqueness บนข้อมูลจริงก่อนใช้** (P6): `GROUP BY key HAVING COUNT(*)>1` ต้องได้ 0 แถว
- ซ่อนไว้หลังฟังก์ชันเดียว → เปลี่ยน strategy ทีหลังได้โดยไม่กระจายทั้งโค้ด

### 4.2 Mapping Store

```
mapping(identity_key PK, container_id, target_record_id, checksum, cr_time, u_time)
```

- **`identity_key` เป็น PK** = collision guard ในตัว (ยิงซ้ำ = upsert ทับ ไม่เกิดแถวซ้ำ)
- **`target_record_id`** = record id ฝั่งปลายทาง — **นี่คือ source of truth** เวลาจะ update/delete ห้ามไป query ปลายทางหา
- **`checksum`** = hash ของ **ข้อมูลที่แปลงแล้ว** (shape เดียวกับที่ส่งขึ้นปลายทาง ไม่ใช่ raw) → ไว้จับ drift ในอนาคต (source เปลี่ยนไหม)
- Idempotent write: `INSERT ... ON DUPLICATE KEY UPDATE` (target_record_id, checksum, u_time)

### 4.3 Ordering Guarantee (จุดพลาดที่เงียบที่สุด)

ถ้า batch-create ปลายทางแล้ว **จับคู่ input↔returned-id ด้วยตำแหน่ง (positional zip)**:

```js
const keys = rows.map(deriveKey);
const ids  = await target.batchCreate(rows);  // เชื่อว่า ids[i] = keys[i]
mappings = keys.map((k, i) => ({ key: k, recordId: ids[i] }));
```

> ⚠️ **ต้อง verify ว่าปลายทางคืน id เรียงตาม input จริง** (ยิง N records ที่ระบุตัวเองได้ แล้วเช็ค 0 mismatch) ถ้าปลายทางสลับลำดับ → mapping ผิดแบบ **silent corruption** (ไม่ error, ข้อมูลดูปกติ, กว่าจะรู้คือสายไป)

---

## 5. Dual-Write Reliability (DB เรา ↔ ปลายทาง external)

ปลายทางเป็น external ไม่มี txn ร่วม → ทุก dual-write มีช่องพัง จัดการด้วย:

### 5.1 Phantom Reservation Self-Heal
`reserveSlots` commit fill_count **ก่อน** เขียนปลายทาง → crash ตรงกลางจะเหลือ "ที่จองผี" (fill_count > จำนวนจริงบนปลายทาง)

**ซ่อมตอน resume:** ก่อนเริ่ม loop ใหม่ เช็ค partition ที่กำลังเปิดอยู่ 1 ครั้ง — ถ้า `fill_count > จำนวนจริงบนปลายทาง` → แก้ fill_count ลงให้ตรง แล้วค่อยจองต่อ
- เช็คแค่ partition ที่ **กำลังจะจองต่อ** พอ (partition ก่อนหน้าปิดไปแล้ว ถูกต้องแล้ว)
- **แก้ลงเท่านั้น ห้ามแก้ขึ้น** — กรณี "เกิน" เป็นคนละปัญหา (orphan จริง) ให้เส้น reconcile จัดการ

### 5.2 Stuck Job Recovery
Worker crash ระหว่างทำ → job ค้าง `claimed` ตลอดไป (claim ปกติดึงแค่ `ready`)
- **แก้:** เพิ่ม lease expiry — ถ้า `claimed` นานเกิน timeout โดย checkpoint ไม่ขยับ → ให้ claim ดึงกลับมาทำใหม่ได้
- **ต้องมี heartbeat คู่กัน** (อัปเดต `claimed_at` ทุก chunk) ไม่งั้นงานยาวหลายชม.จะโดน reclaim ทั้งที่ยังทำงานปกติ — ตั้ง timeout จากเวลาจริงต่อ chunk × safety margin

---

## 6. Reconciliation — Check + Heal (มีให้ครบ)

ระบบ dual-write ยังไงก็ drift ต้องมีเครื่องมือ 2 ตัว:

### 6.1 Check (read-only, ถูก) — 3 ชั้น

| ชั้น | เทียบอะไร | อ่านปลายทาง? | ความถี่ |
|---|---|---|---|
| **L1 Count** | count(source) vs count(mapping) vs count(target) ต่อ partition | แค่ total (1 call/container ถูก) | บ่อย |
| **L2 Drift** | checksum ปัจจุบันของ source vs checksum ใน mapping | ไม่ต้อง | daily |
| **L3 Deep** | ดึง record id จริงมาเทียบ (เฉพาะ partition ที่ L1/L2 แดง) | ต้อง (จำกัดวง) | on-demand |

**Cheap screen first:** ยิง count ถูก ๆ ก่อน เจอไม่ตรงค่อยลง deep-dive แพง เฉพาะจุดที่มีปัญหา

### 6.2 Heal (ซ่อม)
- **fill_count drift** (นับผิดแต่ของจริงตรง) → แก้ bookkeeping เฉย ๆ ไม่แตะปลายทาง
- **เกิน (orphan):** record บนปลายทางไม่มีใน mapping → ลบทิ้ง
- **ขาด (missing):** mapping ชี้ไป record ที่ไม่มีจริง → ดึง source มาสร้างใหม่ + update mapping

### 6.3 ⚠️ กับดัก: Count-only เจอไม่ครบ
**Heal ต้องเทียบด้วย identity (record id) เสมอ ห้าม gate ด้วย count อย่างเดียว**

> เจอจริงตอน test: "เกิน 1 + ขาด 1" ทำให้ count รวมเท่าเดิม (3 = 3) — ถ้าใช้ count screen อย่างเดียวจะข้ามไป ทั้งที่ mapping เสียอยู่ 1 + มี orphan 1
> **check** ใช้ count screen ได้ (มันแค่ approximate) แต่ **heal** ต้อง authoritative → ดึง record จริงมา diff ทุก partition ที่จะซ่อม

### 6.4 อื่น ๆ
- **Resumable:** check/heal วน partition เยอะ ต้องมี budget/timeout + checkpoint แล้วเรียกซ้ำจน `done:true` (เหมือน backfill)
- **Reset เมื่อเริ่มรอบใหม่:** ถ้า checkpoint ถึง partition สุดท้ายแล้ว (รอบก่อนจบ) การเรียกใหม่ต้อง **สแกนใหม่หมด** ไม่ใช่คืนผลเก่า cached
- **Delete detection:** ถ้าต้นทางเป็น physical delete → ต้องมี layer เทียบ **key-set** (source keys vs mapping keys) เพิ่ม เพราะ checksum จับไม่ได้

---

## 7. Verify-Before-Build (ทำเป็นนิสัย)

**อย่าเชื่อ docs ของปลายทาง — ยิงจริงวัดเอง** ก่อนออกแบบ:

| ต้องวัด | ทำไม | บทเรียนจริง |
|---|---|---|
| **Batch cap จริง** | docs มักบอกเลขที่ผิด/คนละ endpoint | endpoint A cap 200, endpoint B (พี่น้องกัน) cap 1000 — เปลี่ยน endpoint ได้ throughput 5 เท่า |
| **Ordering ของ returned ids** | positional zip พังเงียบถ้าไม่เรียง | ยิง 1000 records ที่ระบุตัวเองได้ เช็ค 0 mismatch ก่อนเชื่อ |
| **Rate limit เป็นแบบไหน** | per-app? per-method? per-container? | ถ้า per-app → ยิงขนานข้าม container ไม่ช่วย ต้อง shard หลาย credential |
| **Sustained throughput จริง** | ไว้คำนวณ ETA + ตัดสินใจ shard | ~189 rec/s/app → รู้ว่า backfill 100M ใช้กี่วัน |
| **Data quirks** | timezone, date format, encoding | วันที่เป็น พ.ศ. / ชื่อ column มี space — เจอตอน map จริงถึงจะรู้ |

---

## 8. Checklist ก่อนขึ้น production

- [ ] Backfill: worker แยก process + job queue + keyset cursor + checkpoint-last
- [ ] Idempotent ทุก write (upsert on identity key)
- [ ] Partition pre-provisioned + capacity math มี headroom + spill plan
- [ ] Atomic slot reservation + segment splitting
- [ ] Identity key verify unique บนข้อมูลจริง
- [ ] Returned-id ordering verify แล้ว (ถ้าใช้ positional zip)
- [ ] Mapping store เป็น source of truth (ไม่ query ปลายทางในเส้นปกติ)
- [ ] Self-heal phantom reservation ตอน resume
- [ ] Stuck-job recovery (lease + heartbeat)
- [ ] Reconciliation: check (L1/L2/L3) + heal (identity-based ไม่ใช่ count-only)
- [ ] Credentials lifecycle (ส่งเฉพาะตอนใช้, scrub เมื่อ job จบ)
- [ ] Live-verified: batch cap, ordering, rate limit, throughput, data quirks

---

## 9. Anti-patterns (อย่าทำ)

| ❌ อย่า | ✅ ทำแทน |
|---|---|
| เขียน checkpoint ก่อนเขียนปลายทาง | เขียน checkpoint ท้ายสุดเสมอ (ยอม dup ไม่ยอม loss) |
| Query ปลายทางหา record id ในเส้นปกติ | เก็บ mapping store จำเอง |
| เชื่อ batch cap / behavior จาก docs | ยิงจริงวัดก่อน |
| Heal ด้วยการเทียบ count อย่างเดียว | เทียบ identity (record id) |
| OFFSET pagination บนตารางใหญ่ | keyset cursor |
| สร้าง partition ระหว่างวิ่ง | pre-provision ล่วงหน้า |
| JOIN หา container ทุกครั้งบน hot path | denormalize pointer ลง mapping row |
| Retry error ทุกชนิดเหมือนกัน | แยก transient (retry) vs deterministic (fail เลย) |
