# Com7 → LarkBase Sync API — Reference

Control plane สำหรับ sync ข้อมูลขาย Com7 (MySQL) ขึ้น LarkBase แบบ one-way

## Authentication

ทุก endpoint **ยกเว้น `/health`** ต้องแนบ credential ของ Lark app ผ่าน header:

```
X-Lark-App-Id: <APP_ID>
X-Lark-App-Secret: <APP_SECRET>
Content-Type: application/json
```

Server เอา credential ไปแลก tenant token ต่อ request (ไม่เก็บ secret). ถ้า header หาย/ผิด → `401`.

Base URL (local): `http://localhost:3000`

---

## ตารางสรุปทุกเส้น

| Method + Path | คือเส้นอะไร | เอาไว้ทำอะไร | ใช้ตอนไหน |
|---|---|---|---|
| `GET /health` | liveness + ping ops DB | เช็คว่า service/DB ยังดี | monitoring, ก่อนยิงเส้นอื่น |
| `POST /base/init` | provision base รายปี (250 table+field) | เตรียมโครงให้พร้อม backfill | ครั้งแรกต่อปี / เพิ่มปีใหม่ |
| `POST /base/remove-partitions` | drop table ทั้งปี (teardown) | รื้อ base ที่ provision ผิด | teardown เท่านั้น |
| `GET /base/status` | สถานะ provision (อ่าน MySQL) | ดูว่าปีพร้อมยัง | ตาม /base/init |
| `POST /sync/full` | enqueue backfill ทั้งปี (async job) | เติมข้อมูลครั้งแรกของปี | หลัง /base/init (ต้องมี worker) |
| `GET /sync/full/status` | สถานะ backfill job | ตามงานว่าถึงไหน | ระหว่าง/หลัง backfill |
| `GET /sync/full/check` | reconcile L1/L2 หา drift | ตรวจ Lark ยังตรง Com7 ไหม | ตรวจสุขภาพเป็นระยะ |
| `POST /sync/full/heal` | ซ่อม drift เฉพาะจุด | แก้ส่วนต่าง (ผ่าตัด) | หลัง /check เจอ finding |
| `POST /sync/incremental` | กวาดใหม่+อัปเดต (UTime>watermark) | sync ต่อเนื่อง โหลดเบา | ยิงซ้ำตามรอบ (15น–1วัน) |
| `POST /sync/hard-full` 🔴 | ล้างทั้งปี+rebuild (async job) | กู้ตอนพังหนัก ซ่อมไม่ไหว | ทางเลือกสุดท้าย (confirm:true) |
| `POST /sync/clear-partitions` 🔴 | ล้างทั้งปี **ไม่ rebuild** (async job) | ล้างข้อมูลปีทิ้งอย่างเดียว | เลิกใช้ปีนั้น/จะ backfill เองภายหลัง (confirm:true) |

---

## เส้นทางใช้งานปกติ (Lifecycle)

```
เพิ่มปีใหม่:   /base/init  →  /sync/full  →  /sync/full/status (ตามงาน)
ใช้งานประจำ:   /sync/incremental   (ยิงวนตามรอบ)
ตรวจ / ซ่อม:   /sync/full/check  →  /sync/full/heal
พังหนัก:       /sync/hard-full { confirm:true }   ← reset ทั้งปี (ล้าง+rebuild)
ล้างทิ้ง:      /sync/clear-partitions { confirm:true }   ← ล้างทั้งปี ไม่ rebuild
```

---

## หมายเหตุแยกประเภท

- **async (background job — ต้องมี worker รัน):** `/sync/full`, `/sync/hard-full`, `/sync/clear-partitions` → คืน `jobId` (สถานะ `202`), ไปทำงานเบื้องหลัง ตามผลด้วย `/sync/full/status`
- **sync (รอผลในคำขอเลย):** `/sync/incremental`, `/base/*`, `/sync/full/check`, `/sync/full/heal`

---

# รายละเอียดแต่ละเส้น

## 1. `GET /health`

- **คืออะไร:** เช็คว่า process ยังอยู่ + ต่อ MySQL (ops) ได้ไหม
- **ใช้ตอนไหน:** load balancer / monitoring / เช็คก่อนยิงเส้นอื่น
- **Auth:** ไม่ต้อง

**Request**
```bash
curl http://localhost:3000/health
```

**Response `200`**
```json
{ "status": "ok", "uptime": 1234.56, "opsDb": "ok" }
```

**Error `503` (ต่อ ops DB ไม่ได้)**
```json
{ "status": "degraded", "uptime": 1234.56, "opsDb": "error" }
```

---

## 2. `POST /base/init`

- **คืออะไร:** สร้าง table `itec_001..250` + field ตาม schema จริง ใน base ของปีนั้น (idempotent + resumable)
- **เอาไว้ทำอะไร:** เตรียมโครงให้พร้อมก่อน backfill — คนไปเขียนสูตร Lark manual บน table เหล่านี้
- **ใช้ตอนไหน:** ครั้งแรกต่อปี / เพิ่มปีใหม่ (สร้าง base เปล่าใน Lark เอง แล้วส่ง `base` มา). ยิงซ้ำได้ ถ้า budget หมดคืน partial → ยิงต่อจนครบ

**Header**
```
X-Lark-App-Id: <APP_ID>
X-Lark-App-Secret: <APP_SECRET>
```

**Request**
```json
{ "year": 2026, "base": "TihrbIr5PaNwI7sS9jFl6gCrgCg" }
```

**Response `200`**
```json
{ "year": 2026, "base": "TihrbIr5PaNwI7sS9jFl6gCrgCg", "total": 250, "existing": 100, "created": 150, "remaining": 0, "done": true }
```
> `done:false` = ยังสร้างไม่ครบ (budget หมด) → ยิงซ้ำ

**Error `400` (params ผิด)**
```json
{ "error": "year must be an integer year (CE)" }
```

**Error `404` (base ไม่พบ / app เข้าไม่ถึง)**
```json
{ "error": "base not found: TihrbIr5PaNwI7sS9jFl6gCrgCg" }
```

---

## 3. `POST /base/remove-partitions`

- **คืออะไร:** **drop** table `itec_*` ของปีนั้นทิ้ง (ลบทั้ง table ไม่ใช่แค่ record)
- **เอาไว้ทำอะไร:** รื้อ base ที่ provision ผิด / เลิกใช้ปีนั้น
- **ใช้ตอนไหน:** teardown เท่านั้น — **ไม่ใช่**สำหรับล้างข้อมูล (อันนั้นใช้ `/sync/hard-full`). แนะนำ `?dryRun=true` ดูก่อน
- **Query:** `dryRun=true` → แค่บอกว่าจะลบอะไร ไม่ลบจริง

**Request (dry run)**
```bash
curl -X POST "http://localhost:3000/base/remove-partitions?dryRun=true" \
  -H "X-Lark-App-Id: <APP_ID>" -H "X-Lark-App-Secret: <APP_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{ "year": 2026, "base": "TihrbIr5PaNwI7sS9jFl6gCrgCg" }'
```

**Response `200` (dryRun)**
```json
{ "year": 2026, "base": "TihrbIr5PaNwI7sS9jFl6gCrgCg", "total": 250, "deleted": 0, "remaining": 250, "done": false, "dryRun": true, "tables": ["itec_001", "itec_002"] }
```

**Response `200` (ลบจริง)**
```json
{ "year": 2026, "base": "TihrbIr5PaNwI7sS9jFl6gCrgCg", "total": 250, "deleted": 250, "remaining": 0, "done": true }
```

**Error `400` / `404`**
```json
{ "error": "base is required" }
```

---

## 4. `GET /base/status`

- **คืออะไร:** ดูว่าปีนั้น provision ไปกี่ partition แล้ว (อ่านจาก ops ไม่ยิง Lark → เร็ว)
- **ใช้ตอนไหน:** เช็คความคืบหน้า `/base/init` หรือดูว่าปีพร้อม backfill ยัง
- **Query:** `year` (required)

**Request**
```bash
curl "http://localhost:3000/base/status?year=2026" \
  -H "X-Lark-App-Id: <APP_ID>" -H "X-Lark-App-Secret: <APP_SECRET>"
```

**Response `200`**
```json
{ "year": 2026, "base": "TihrbIr5PaNwI7sS9jFl6gCrgCg", "status": "complete", "total": 250, "existing": 250, "missing": 0, "complete": true }
```

**Error `400` (year หาย)**
```json
{ "error": "year query param is required and must be an integer" }
```

**Error `404` (ปียังไม่ provision)**
```json
{ "error": "year not provisioned: 2026" }
```

---

## 5. `POST /sync/full`

- **คืออะไร:** สั่ง backfill ข้อมูล **ทั้งปี** จาก itec → Lark (ดึงเป็น chunk, จอง partition, เขียน mapping)
- **เอาไว้ทำอะไร:** เติมข้อมูลครั้งแรกของปี / เพิ่มปีย้อนหลัง
- **ใช้ตอนไหน:** หลัง `/base/init` เสร็จ. **async** — คืน jobId แล้วไปทำเบื้องหลัง (ต้องมี worker). idempotent: ถ้ามี job ปีนั้น active คืนตัวเดิม

**Request**
```json
{ "year": 2026 }
```

**Response `202`**
```json
{ "year": 2026, "jobId": 42, "status": "ready" }
```

**Error `400` (year ไม่ใช่ integer)**
```json
{ "error": "year must be an integer year (CE)" }
```

**Error `404` (ปียังไม่ provision)**
```json
{ "error": "year not provisioned: 2026" }
```

---

## 6. `GET /sync/full/status`

- **คืออะไร:** สถานะ job + checkpoint ล่าสุด (อ่าน ops ไม่ยิง Lark)
- **ใช้ตอนไหน:** ตามงาน backfill ที่สั่งไป ว่าถึงไหน/เสร็จ/ตาย
- **Query:** `year` (required)

**Request**
```bash
curl "http://localhost:3000/sync/full/status?year=2026" \
  -H "X-Lark-App-Id: <APP_ID>" -H "X-Lark-App-Secret: <APP_SECRET>"
```

**Response `200`**
```json
{ "year": 2026, "jobStatus": "claimed", "jobId": 42, "attempts": 0, "checkpoint": { "sellId": 1008889, "rowNo": 2 }, "lastRunAt": "2026-07-08 09:41:47" }
```
> `jobStatus`: `not_started` \| `ready` \| `claimed` \| `done` \| `dead`

**Error `400` (year หาย)**
```json
{ "error": "year query param is required and must be an integer" }
```

---

## 7. `GET /sync/full/check`

- **คืออะไร:** เทียบ count(source) vs total บน Lark (L1) + checksum drift (L2) ต่อ partition
- **เอาไว้ทำอะไร:** ตรวจว่าข้อมูล Lark ยังตรงกับ Com7 ไหม โดยไม่ fetch record จาก Lark
- **ใช้ตอนไหน:** ตรวจสุขภาพเป็นระยะ / ก่อนตัดสินใจ heal
- **Query:** `year` (required)

**Request**
```bash
curl "http://localhost:3000/sync/full/check?year=2026" \
  -H "X-Lark-App-Id: <APP_ID>" -H "X-Lark-App-Secret: <APP_SECRET>"
```

**Response `200`**
```json
{ "year": 2026, "done": true, "partitionsChecked": 250, "partitionsTotal": 250, "findings": [] }
```
> `findings` มีสมาชิก = เจอ drift (partition ไหน count/checksum ไม่ตรง)

**Error `400` / `404`**
```json
{ "error": "year not provisioned: 2026" }
```

---

## 8. `POST /sync/full/heal`

- **คืออะไร:** ซ่อมเฉพาะจุดที่เพี้ยน — ลบ orphan / สร้าง record ที่หาย ให้ Lark = source
- **เอาไว้ทำอะไร:** แก้ drift แบบ **ผ่าตัดเฉพาะจุด** (ไม่ใช่ล้างทั้งปี)
- **ใช้ตอนไหน:** หลัง `/check` เจอ finding — ลองซ่อมก่อนตัดสินใจใช้ hard-full

**Request**
```json
{ "year": 2026 }
```

**Response `200`**
```json
{ "year": 2026, "done": true, "partitionsProcessed": 250, "partitionsTotal": 250, "actionsTaken": [ { "partitionNo": 10, "larkTableId": "tbl10", "orphansDeleted": 2, "recordsRecreated": 0 } ] }
```

**Error `400` (year ไม่ใช่ integer)**
```json
{ "error": "year must be an integer year (CE)" }
```

**Error `404` (ปียังไม่ provision)**
```json
{ "error": "year not provisioned: 2026" }
```

---

## 9. `POST /sync/incremental`

- **คืออะไร:** ดึงแถวที่ `UTime >= last_sync` จาก **itec + itec-today** → insert (ใหม่) / update (checksum เปลี่ยน) / skip (เหมือนเดิม) แล้วเลื่อน watermark
- **เอาไว้ทำอะไร:** sync ต่อเนื่อง หลัง backfill รอบแรก — โหลดเบา (ทำเฉพาะที่เปลี่ยน)
- **ใช้ตอนไหน:** ยิงซ้ำ ๆ ตามรอบ (เช่นทุก 15 นาที–1 วัน). **sync** — รอผลในคำขอเลย. ไม่ต้องส่ง body. ทุก call กวาด backlog ให้หมดในครั้งเดียว

**Request**
```bash
curl -X POST http://localhost:3000/sync/incremental \
  -H "X-Lark-App-Id: <APP_ID>" -H "X-Lark-App-Secret: <APP_SECRET>"
```

**Response `200`**
```json
{ "since": "2026-07-03 00:00:00", "newWatermark": "2026-07-08 21:58:10", "scanned": 1023, "inserted": 300, "updated": 0, "skipped": 723, "ignoredRows": 0, "ignoredYears": [] }
```
> รอบถัดไปถ้าไม่มีอะไรเปลี่ยน: `scanned` น้อย/0, `inserted`+`updated` = 0

แถวที่ `CrTime` ชี้ไปปีที่ยังไม่ provision (`sync_year` ไม่มีหรือ `status !== 'complete'`) จะถูก **ข้าม** — ไม่ sync ทาง incremental แต่ watermark ยังเลื่อนผ่านแถวเหล่านั้น (ต้อง `POST /sync/init` backfill ทีหลังถ้าต้องการข้อมูลปีนั้น):

```json
{ "since": "2026-07-03 00:00:00", "newWatermark": "2026-07-08 21:58:10", "scanned": 50, "inserted": 10, "updated": 0, "skipped": 0, "ignoredRows": 40, "ignoredYears": [2015, 2027] }
```

**Error `409` (มี background job กำลังรัน — `full_sync` / `hard_full_sync` / `clear_partitions`)**
```json
{
  "error": "background sync job is running",
  "jobs": [{ "jobId": 42, "year": 2026, "status": "claimed", "type": "full_sync" }]
}
```
> ไม่ดึง Com7 / ไม่เลื่อน watermark — รอ job จบแล้วยิง incremental ใหม่

---

## 10. `POST /sync/hard-full` 🔴

- **คืออะไร:** **ลบ record ทั้งหมด**ของปีบน Lark + เคลียร์ mapping/state → แล้ว enqueue backfill ใหม่ (คง table + สูตรไว้)
- **เอาไว้ทำอะไร:** กู้ตอนข้อมูลพังหนักจน `/heal` ซ่อมไม่ไหว — "เผาทิ้งแล้วสร้างใหม่"
- **ใช้ตอนไหน:** ทางเลือกสุดท้าย. **background job** (ต้องมี worker) + ใช้เวลานาน (ลบล้าน + สร้างล้าน)
- ⚠️ ทำลายข้อมูลจริง — บังคับ `confirm: true`

**Request**
```json
{ "year": 2026, "confirm": true }
```

**Response `202`**
```json
{ "year": 2026, "jobId": 55, "status": "ready" }
```

**Error `400` (ไม่ได้ยืนยัน)**
```json
{ "error": "hard-full-sync deletes all records for the year; pass { \"confirm\": true } to proceed" }
```

**Error `400` (year ไม่ใช่ integer)**
```json
{ "error": "year must be an integer year (CE)" }
```

**Error `404` (ปียังไม่ provision)**
```json
{ "error": "year not provisioned: 2026" }
```

---

## 11. `POST /sync/clear-partitions` 🔴

- **คืออะไร:** เหมือน `/sync/hard-full` — **ลบ record ทั้งหมด**ของปีบน Lark + เคลียร์ mapping/state (คง table + สูตรไว้) — **แต่ไม่ enqueue backfill** ต่อ ปีจึงว่างเปล่า
- **เอาไว้ทำอะไร:** ล้างข้อมูลปีทิ้งอย่างเดียว โดยไม่เติมใหม่ (เช่น เลิกใช้ปีนั้น หรือจะ backfill เองภายหลังด้วย `/sync/full`)
- **ใช้ตอนไหน:** **background job** (ต้องมี worker) + ใช้เวลานาน (ลบล้าน). ต่างจาก hard-full ตรงไม่มีขั้น rebuild
- **หลังล้าง:** year status ยังเป็น `complete` (ตารางยังอยู่); `full_sync` checkpoint ถูก reset — ยิง `/sync/full` ทีหลังจะเริ่ม backfill จากศูนย์
- ⚠️ ทำลายข้อมูลจริง — บังคับ `confirm: true`

**Request**
```json
{ "year": 2026, "confirm": true }
```

**Response `202`**
```json
{ "year": 2026, "jobId": 77, "status": "ready" }
```

**Error `400` (ไม่ได้ยืนยัน)**
```json
{ "error": "clear-partitions deletes all records for the year; pass { \"confirm\": true } to proceed" }
```

**Error `400` (year ไม่ใช่ integer)**
```json
{ "error": "year must be an integer year (CE)" }
```

**Error `404` (ปียังไม่ provision)**
```json
{ "error": "year not provisioned: 2026" }
```

---

## Error ทั่วไป (ทุกเส้นที่ต้อง auth)

**`401` (header หาย/credential ผิด)**
```json
{ "error": "invalid or missing Lark credentials" }
```
