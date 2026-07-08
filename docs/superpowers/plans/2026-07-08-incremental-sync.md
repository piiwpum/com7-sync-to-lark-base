# Incremental Sync (new + updated, UTime watermark) Implementation Plan

> Flow B + C ยุบเป็น endpoint เดียว ขับด้วย `UTime` watermark ล้วน (ตกลงกับเจ้าของงาน 2026-07-08).
> อ้างอิงดีไซน์: [sync-architecture.md](../../sync-architecture.md) §8.B/§8.C, §10.

---

## Goal

`POST /sync/incremental` — ดึง row ที่ **ใหม่หรือถูกแก้** จาก Com7 ตั้งแต่ครั้งล่าสุด แล้ว push ขึ้น
Lark base รายปี (insert ถ้าไม่เคยเห็น, update ถ้าเคย) โดยไม่ fetch จาก Lark เลย

```
POST /sync/incremental   (auth: X-Lark-App-Id / X-Lark-App-Secret)
 1. since = sync_state['incremental'].last_utime  ?? config.incremental.defaultSince (mock 2026-07-03)
 2. rows = fetchChangedSince({ since })            ← itec ∪ daily_itec_temp,  UTime >= since
      └─ dedup by deriveKey(): row ซ้ำสองตาราง → เก็บตัว UTime ใหม่กว่า
 3. group rows by year (CrTime → CE year):
      findByKeys(year, sourceKeys) ใน sync_mapping
        เจอ + checksum ต่าง → batchUpdate ไป record เดิม, refresh checksum/u_time
        เจอ + checksum เท่า  → skip (in sync แล้ว)
        ไม่เจอ               → reserveSlots + batchCreate + saveMappings  (เหมือน backfill)
 4. stamp sync_state['incremental'].last_utime = max(UTime ที่ประมวลผล), last_run_at = now
 5. คืน summary { since, newWatermark, scanned, inserted, updated, skipped }
```

**ทำไม synchronous (ไม่ผ่าน job_queue/worker):** โมเดลที่ตกลง = "เรียก api → ทำ → stamp".
delta ปกติเล็ก (เฉพาะที่เปลี่ยนตั้งแต่รอบก่อน) และ **watermark = checkpoint ในตัว** อยู่แล้ว →
ถ้าชน budget แล้วคืน partial รอบถัดไปยิงต่อจาก watermark ที่ขยับได้เอง ไม่ต้องแตะ worker
(ปัจจุบัน `worker.js` เรียก `runFullSyncJob` ทุก job ไม่ได้ switch ตาม `job.type` — เลยยังใช้ enqueue ไม่ได้อยู่ดี).

---

## Global Constraints

- **TDD ทุก task**: เขียน test ให้ fail ก่อน → implement → pass → commit (แนวเดียวกับ full-sync plan).
- **One-way**: ห้ามเขียนกลับ Com7 (SourceRepository อ่านอย่างเดียว).
- **ห้าม fetch Lark ใน sync path** (§3) — routing update/insert อ่านจาก `sync_mapping` เท่านั้น.
- **BE→CE**: ทุก datetime จาก Com7 เป็น พ.ศ. → แปลงด้วย `transformItecRow` / `beDateStringToEpochMs` เดิม.
- **Idempotent**: `UTime >= since` (ไม่ใช่ `>`) + update idempotent + insert ชน `(year, source_key)` PK → กลายเป็น update. reprocess ขอบ watermark ซ้ำต้องไม่ทำข้อมูลเพี้ยน/ซ้ำ.
- **Reuse** ให้มากที่สุด: `deriveKey`, `crc32`, `transformItecRow`, `dateConversion`, `reserveSlots`, `saveMappings`, `updatePartitionBoundary`, `getState/setState`, `yearRepository.getYear`.

## Gaps ที่ต้องสร้าง (ยืนยันจากโค้ดจริง 2026-07-08)

| # | ของ | สถานะปัจจุบัน |
|---|---|---|
| 1 | `LarkGateway.batchUpdate` | port ประกาศไว้ — **ไม่มีใน `LarkGatewayHttp`** (มีแค่ create/delete) |
| 2 | `SourceRepository.fetchChangedSince` | port ประกาศไว้ — **ไม่มีใน `SourceRepositoryMysql`** |
| 3 | `MappingRepository.findByKeys` | port ประกาศไว้ — **ไม่มีใน `MappingRepositoryMysql`** (export ไม่มี) |
| 4 | `config.incremental.defaultSince` | ยังไม่มีใน `env.js` |
| 5 | `RunIncrementalSync` use-case | ยังไม่มี |
| 6 | `POST /sync/incremental` controller + route + wiring | ยังไม่มี |

## File Structure

```
src/domain/services/sourceYear.js                 ← ใหม่ (CrTime BE-string → CE year)
src/infrastructure/lark/LarkGatewayHttp.js         ← + batchUpdate
src/infrastructure/database/SourceRepositoryMysql.js ← + fetchChangedSince
src/infrastructure/database/MappingRepositoryMysql.js ← + findByKeys
src/infrastructure/config/env.js                   ← + incremental.defaultSince
src/application/use-cases/RunIncrementalSync.js    ← ใหม่
src/infrastructure/web/controllers/SyncController.js ← + incremental handler
src/infrastructure/web/routes/sync.js              ← + POST /sync/incremental
src/infrastructure/web/app.js                      ← wire RunIncrementalSync
test/... (คู่ขนานทุกไฟล์)
```

---

## Task 1: `LarkGateway.batchUpdate` (bitable/v1)

**ไฟล์:** `src/infrastructure/lark/LarkGatewayHttp.js`, `test/infrastructure/lark/LarkGatewayHttp.test.js`

- [ ] **Step 1: Write failing test** — inject fake `fetchFn`; assert:
  - POST ไป `/open-apis/bitable/v1/apps/{baseId}/tables/{tableId}/records/batch_update`
  - body = `{ records: [{ record_id, fields }, ...] }` (จาก `records:[{recordId, fields}]`)
  - คืน `record_id[]` ตามลำดับ input
  - retry บน rate-limit codes เดิม (`RATE_LIMIT_CODES`) — reuse `writeCall`
- [ ] **Step 2: Run → fail**
- [ ] **Step 3: Implement** (mirror `batchCreate`, บรรทัด 89–96):
  ```js
  async function batchUpdate({ baseId, tableId, records }) {
    const b = await writeCall(
      `/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}/records/batch_update`,
      { body: { records: records.map(({ recordId, fields }) => ({ record_id: recordId, fields })) } },
      'batchUpdate',
    );
    return b.data.records.map((r) => r.record_id);
  }
  ```
  เพิ่ม `batchUpdate` ใน return object (บรรทัด 130).
- [ ] **Step 4: Run → pass**
- [ ] **Step 5: Commit** — `feat: LarkGatewayHttp.batchUpdate (bitable/v1 batch_update)`

> ⚠️ batch cap ของ `batch_update` ต้อง **verify live** (Task 7) — สมมติ 1,000/call เหมือน create แต่ยังไม่ยืนยัน; caller (use-case) chunk เผื่อไว้.

---

## Task 2: `sourceYear` helper (CrTime BE → CE year)

**ไฟล์:** `src/domain/services/sourceYear.js`, `test/domain/services/sourceYear.test.js`

จำเป็นเพราะ update/insert routing ต้องรู้ปี (base) ต่อ row จาก `CrTime` (immutable, §Decision #9).

- [ ] **Step 1: Write failing test** — `crYear({ CrTime: '2569-05-14 09:00:00' }) === 2026`; รองรับ `Date` object และ string; ปีขอบ (`2560-01-01` → 2017).
- [ ] **Step 2: Run → fail**
- [ ] **Step 3: Implement**:
  ```js
  const BE_OFFSET_YEARS = 543;
  /** CE year a row belongs to, from its immutable BE CrTime (§Decision #9). */
  export function crYear(row) {
    const s = typeof row.CrTime === 'string' ? row.CrTime : row.CrTime.toISOString();
    return Number(s.slice(0, 4)) - BE_OFFSET_YEARS;
  }
  ```
- [ ] **Step 4: Run → pass**
- [ ] **Step 5: Commit** — `feat: sourceYear.crYear — route a row to its CE year base`

---

## Task 3: `SourceRepository.fetchChangedSince` (itec ∪ daily_itec_temp)

**ไฟล์:** `src/infrastructure/database/SourceRepositoryMysql.js`, `test/infrastructure/database/SourceRepositoryMysql.test.js`

- [ ] **Step 1: Write failing test** (fake pool / mock rows) — assert:
  - query ทั้ง `itec` และ `daily_itec_temp` ด้วย `WHERE UTime >= ?` (BE string ของ `since`)
  - **dedup by `deriveKey`**: row เดียวกันโผล่สองตาราง → เก็บตัว `UTime` ใหม่กว่า
  - ผลลัพธ์ **ordered by UTime ascending** (เพื่อให้ watermark ขยับถูกเวลาโดน budget ตัด)
  - เคารพ `limit`
- [ ] **Step 2: Run → fail**
- [ ] **Step 3: Implement** — `since` เป็น CE `Date`/string → แปลงเป็น BE string ก่อน compare (บวก 543 ปี, reuse pattern `beYearRange`):
  ```js
  async function fetchChangedSince({ since, limit }) {
    const sinceBE = ceDatetimeToBeString(since);        // +543y, 'YYYY-MM-DD HH:MM:SS'
    const q = `SELECT * FROM ?? WHERE UTime >= ? ORDER BY UTime, SellID, RowNo LIMIT ?`;
    const [a] = await pool.query(q, ['itec', sinceBE, limit]);
    const [b] = await pool.query(q, ['daily_itec_temp', sinceBE, limit]);
    const byKey = new Map();                              // dedup, keep newer UTime
    for (const r of [...a, ...b]) {
      const k = deriveKey(r);
      const prev = byKey.get(k);
      if (!prev || r.UTime > prev.UTime) byKey.set(k, r);
    }
    return [...byKey.values()].sort((x, y) => (x.UTime < y.UTime ? -1 : x.UTime > y.UTime ? 1 : 0)).slice(0, limit);
  }
  ```
  เพิ่ม helper `ceDatetimeToBeString` (หรือ reuse `beYearRange`-style) ในไฟล์นี้.
- [ ] **Step 4: Run → pass**
- [ ] **Step 5: Commit** — `feat: SourceRepositoryMysql.fetchChangedSince (itec ∪ daily_itec_temp, UTime watermark)`

> ⚠️ **Perf**: ถ้า `itec.UTime` ไม่มี index → `WHERE UTime >= ?` = full scan. **Task 7 ต้อง `EXPLAIN`** บน mock; ถ้าเป็น `ALL` (full scan) → ยกเป็นข้อเสนอขอ index กับ Com7 (นอก scope โค้ดนี้).

---

## Task 4: `MappingRepository.findByKeys` (MySQL adapter)

**ไฟล์:** `src/infrastructure/database/MappingRepositoryMysql.js`, `test/infrastructure/database/MappingRepositoryMysql.test.js`

- [ ] **Step 1: Write failing test** — insert mapping rows, เรียก `findByKeys({ year, sourceKeys })`, assert คืน `Map<sourceKey, Mapping>` เฉพาะที่มีจริง (keys ที่ไม่มี = ไม่อยู่ใน map). ยืนยันใช้ PK `(year, source_key)` (point lookup, ไม่ scan).
- [ ] **Step 2: Run → fail**
- [ ] **Step 3: Implement** — `SELECT ... WHERE year = ? AND source_key IN (?)`; map แต่ละ row → `new Mapping({...})` (คืน field ครบ: baseId, partitionNo, larkTableId, larkRecordId, checksum, crTime, uTime). เพิ่ม `findByKeys` ใน return object.
- [ ] **Step 4: Run → pass**
- [ ] **Step 5: Commit** — `feat: MappingRepositoryMysql.findByKeys — point-lookup routing for incremental`

---

## Task 5: `config.incremental.defaultSince`

**ไฟล์:** `src/infrastructure/config/env.js`, `.env.example`

- [ ] เพิ่ม block (default = วัน deploy ที่ Com7; mock ปัจจุบัน `2026-07-03`):
  ```js
  incremental: {
    // Watermark เริ่มต้นเมื่อ sync_state['incremental'] ว่าง (ยังไม่เคยยิง).
    // Prod = วันที่ deploy service ที่ Com7. Mock ตอนนี้ = 2026-07-03.
    defaultSince: process.env.INCREMENTAL_DEFAULT_SINCE ?? '2026-07-03 00:00:00',
    budgetMs: num(process.env.INCREMENTAL_BUDGET_MS, 600000),
    chunkSize: num(process.env.INCREMENTAL_CHUNK_SIZE, 1000),
  },
  ```
- [ ] เพิ่ม key ใน `.env.example`
- [ ] **Commit** — `feat: config.incremental (defaultSince/budget/chunkSize)`

---

## Task 6: `RunIncrementalSync` use-case (TDD, fakes)

**ไฟล์:** `src/application/use-cases/RunIncrementalSync.js`, `test/application/RunIncrementalSync.test.js`

- [ ] **Step 1: Write failing tests** ครอบเคส:
  1. ว่าง (ไม่มี state) → ใช้ `defaultSince`
  2. row ใหม่ (ไม่มีใน mapping) → `reserveSlots` + `batchCreate` + `saveMappings`, boundary update
  3. row แก้ (มีใน mapping, checksum ต่าง) → `batchUpdate` ไป `larkRecordId` เดิม + `saveMappings` (refresh checksum/u_time, partition/table เดิม)
  4. row เดิมไม่เปลี่ยน (checksum เท่า) → **skip** (ไม่เรียก Lark)
  5. rows คร่อมหลายปี → group by `crYear`, เรียก `getYear`/`findByKeys` ต่อปี
  6. watermark ขยับ = `max(UTime)` ที่ประมวลผล (ไม่ใช่ `now()`); ไม่มี row → state ไม่ขยับ, คืน `scanned:0`
  7. budget/limit → คืน partial, watermark ขยับเท่าที่ทำ (รอบถัดไปต่อได้)
- [ ] **Step 2: Run → fail**
- [ ] **Step 3: Implement** — constructor DI แบบ `RunFullSyncJob` (sourceRepository, mappingRepository, yearRepository, gateway|createGateway, config, now). สเก็ตช์:
  ```js
  async execute({ gateway }) {                       // gateway มาจาก larkAuth (req.larkGateway)
    const state = await this.mappingRepository.getState('incremental');
    const since = state?.last_utime ?? this.defaultSince;
    const rows = await this.sourceRepository.fetchChangedSince({ since, limit: this.chunkSize });
    if (rows.length === 0) return { since, newWatermark: since, scanned: 0, inserted: 0, updated: 0, skipped: 0 };

    const byYear = groupBy(rows, crYear);
    let inserted = 0, updated = 0, skipped = 0, maxUtime = since;

    for (const [year, yearRows] of byYear) {
      const { baseId } = await this.yearRepository.getYear(year);
      const keys = yearRows.map(deriveKey);
      const existing = await this.mappingRepository.findByKeys({ year, sourceKeys: keys });

      const toInsert = [], toUpdate = [];
      for (const row of yearRows) {
        const t = transformItecRow(row);
        const checksum = crc32(JSON.stringify(t));
        const cur = existing.get(deriveKey(row));
        if (!cur) toInsert.push({ row, t, checksum });
        else if (cur.checksum !== checksum) toUpdate.push({ row, t, checksum, cur });
        else skipped++;
        if (row.UTime > maxUtime) maxUtime = row.UTime;   // เทียบใน CE-normalized (ดูหมายเหตุ)
      }

      // INSERT: reuse backfill machinery (reserveSlots → batchCreate → saveMappings → boundary)
      inserted += await this.#insert(gateway, year, baseId, toInsert);
      // UPDATE: group by larkTableId → batchUpdate → saveMappings (refresh checksum/u_time)
      updated  += await this.#update(gateway, year, baseId, toUpdate);
    }

    const newWatermark = maxUtimeCE(maxUtime);           // เก็บเป็น CE datetime string
    await this.mappingRepository.setState('incremental', { last_utime: newWatermark, last_run_at: nowStr() });
    return { since, newWatermark, scanned: rows.length, inserted, updated, skipped };
  }
  ```
  - `#insert`: เหมือน loop ใน `RunFullSyncJob` (บรรทัด 96–128) — `reserveSlots({year, count})` → ต่อ segment `batchCreate` → `saveMappings` + `updatePartitionBoundary`.
  - `#update`: group `toUpdate` ตาม `cur.larkTableId` → `gateway.batchUpdate({ baseId, tableId, records:[{recordId: cur.larkRecordId, fields: t}] })` → `saveMappings` ด้วย Mapping เดิม (partition/table/record เดิม, checksum/u_time ใหม่). ไม่แตะ `reserveSlots`/boundary.
  - **Watermark เก็บเป็น CE** (`u_time` ใน sync_state เป็น CE เหมือน sync_mapping): normalize ตอน setState. `since` ที่อ่านออกมาเป็น CE → `fetchChangedSince` แปลงกลับเป็น BE ตอน query (Task 3). ระวังให้ direction เดียวกันตลอด.
- [ ] **Step 4: Run → pass**
- [ ] **Step 5: Commit** — `feat: RunIncrementalSync — UTime-watermark update/insert into yearly base`

> **Crash window (รับได้ เหมือน full-sync §10):** batchCreate สำเร็จแต่ setState ยังไม่ทัน → รอบใหม่ reprocess ช่วงเดิม: insert ชน `(year, source_key)` PK → `ON DUPLICATE KEY UPDATE` repoint mapping (อาจ orphan record แรก, ปล่อยให้ reconciliation P5). update = idempotent. **ห้าม**เขียน watermark ก่อน Lark write (จะกลายเป็น row หายแทน ซึ่งแย่กว่า).

---

## Task 7: Wire endpoint + live verification

**ไฟล์:** `SyncController.js`, `routes/sync.js`, `app.js`, `test/infrastructure/web/syncRoute.test.js`

- [ ] **Step 1: Route test (fail)** — `POST /sync/incremental` ผ่าน `larkAuth`, เรียก use-case ด้วย `req.larkGateway`, คืน `200` + summary; ไม่มี auth header → `401`.
- [ ] **Step 2: Implement handler** ใน `SyncController` (`incremental = async (req,res,next)=>{...}` เรียก `this.runIncrementalSync.execute({ gateway: req.larkGateway })`, คืน `200`), route `router.post('/incremental', larkAuth, syncController.incremental)`, wire `RunIncrementalSync` ใน `app.js` composition root (inject sourceRepository/mappingRepository/yearRepository/config).
- [ ] **Step 3: Run test suite → pass** (`node --test`)
- [ ] **Step 4: Live verify** (แนวเดียวกับ full-sync ก่อน merge):
  - `EXPLAIN SELECT * FROM itec WHERE UTime >= ...` บน mock → ดู scan type (บันทึกผลใน §perf ของ sync-architecture.md)
  - ยิงจริงบน Lark test base: (a) แก้ 2–3 row ต้นทาง → ยืนยัน **update** (record เดิม, ไม่เกิดตัวใหม่) (b) เพิ่ม row ใหม่ → **insert** + mapping ถูก (c) ยิงซ้ำทันที → **skip ทั้งหมด** (checksum เท่า, watermark กันซ้ำ) (d) verify `batch_update` cap จริง
- [ ] **Step 5: Commit** — `feat: POST /sync/incremental — wire + live-verified update/insert path`

---

## Out of scope (ยัง ไม่ ทำรอบนี้)

- **Delete detection** — watermark จับ delete ไม่ได้ (ทั้ง physical delete ใน itec และ row ที่หายจาก daily_itec_temp). daily row ที่หาย = ถูก merge เข้า itec ถาวรแล้ว (ไม่ควรลบ). physical-delete historical → reconciliation L1–L3 (§9, P5).
- **Midnight ordering / lock** (§10) — ยังไม่มี state machine กันชนช่วงเที่ยงคืน (merge + incremental พร้อมกัน). incremental นี้ idempotent อยู่แล้ว แต่การ freeze/handoff C→B→D ยกไป P4.
- **Trigger/scheduler** — endpoint เฉย ๆ; ใครยิง (Lark workflow / cron ภายนอก) ไม่อยู่ใน scope.
- **Com7 UTime index** — ถ้า `EXPLAIN` เป็น full scan → เป็นข้อเสนอฝั่ง Com7 (นอก repo นี้).
