# Spec — `POST /years` (Init Year Base / Provision Partitions)

> ส่วนแรกของ **Lark setup** (1 ใน 3 ส่วนหลัก: Lark setup · full sync ตามปี · interval sync)
> วันที่: 2026-07-03 · สถานะ: design approved, รอ review ก่อนทำ plan

---

## 1. Goal

Endpoint สำหรับ **provision year base**: รับ `{year, base}` แล้วทำให้ base นั้นมี partition table
`itec_001 .. itec_250` ครบ (แต่ละ table มี 41 fields ตาม schema) แบบ **idempotent + resumable**

Related decisions (จาก [../../sync-architecture.md](../../sync-architecture.md)):
- **1 base / 1 ปี** (year = ค.ศ.), base สร้าง manual แล้วส่ง `base_id` เข้ามา
- **250 partition/base** (250×50K = 12.5M/ปี ceiling)
- **daily แยกเป็นอีก base ต่างหาก** — year base มีแค่ 250 itec ไม่มี daily ปน
- **Approach A: Lark `table-list` = source of truth** ว่า partition ไหนมีจริง (ไม่พึ่ง MySQL → เริ่มได้เลย)

---

## 2. API Contract

```
POST /years
Body: { "year": 2024, "base": "QRqjbxgQ2aqzPksV6MAlhCRvgSd" }   // year = ค.ศ.
```

| กรณี | Response |
|---|---|
| input ไม่ valid | `400 { "error": "<reason>" }` |
| base ไม่เจอ | `404 { "error": "base not found: <id>" }` |
| ทำงาน (อาจยังไม่ครบ) | `200 { year, base, total:250, existing, created, remaining, done }` |

- `done: true` = ครบ 250 แล้ว · `done: false` = ชน guard → **เรียกซ้ำเพื่อทำต่อ**
- **Idempotent:** เรียกซ้ำปลอดภัยเสมอ (สร้างเฉพาะที่ยังขาด)

---

## 3. Field Schema (41 fields)

ชื่อ field บน Lark = ชื่อตรงตาม schema sheet เป๊ะ (รวมที่มี space / `/` / `%`) — เพราะสูตร manual ผูกกับชื่อเหล่านี้

**✅ Verified บน Lark จริง (2026-07-03):** สร้าง table + 41 fields สำเร็จ (`tbl9KLdb3fqy2nVI`), ชื่อพิเศษ + type ทั้งหมดผ่าน

| SQL type | Lark type | precision | fields |
|---|---|---|---|
| `datetime` | datetime (`yyyy-MM-dd HH:mm`) | แปลง พ.ศ.→ค.ศ. + epoch ms | CrTime, UTime |
| `int` | number | 0 | SellID, SellBranch, NUMBER, CategoryID, CustomerTypeID, STATUS, is_return, is_tradein, is_unbrick |
| `money` | number | 2 | MIN PRICE, SRP, TOTAL PBV, COGS / UNIT, COGS, GP, VAT %, VATValue, TotalPrice |
| `numeric(19,4)` | number | 4 | PBV, PAV, TOTAL PAV, GP / UNIT |
| `float` | number | 2 | VAT, GP %, VAT ALLOCATE |
| `varchar` | text | — | Product, Product Name, CategoryName, SubCat, Brand, Model, ProductType, Customer Code, Customer Name, Customer Type, Branch Name, SerialShouldSalesFirst, mem_code, Comment |

- เก็บเป็น config module เดียว `src/infrastructure/config/itecFieldSchema.js` (source of truth ของ field spec) → apply ทุก partition
- หมายเหตุ: `datetime`/`epoch`/`พ.ศ.→ค.ศ.` เป็นเรื่องของ **full sync** (ตอนเขียน record); ขั้น provision แค่ประกาศ field type = datetime

---

## 4. Flow

```
POST /years {year, base}
 └─ 1. validate: year เป็น int ค.ศ. (เช่น 2016..2026), base ไม่ว่าง        → 400 ถ้าไม่ผ่าน
 └─ 2. LarkGateway.getBase(base)                                        → 404 ถ้าไม่เจอ
 └─ 3. LarkGateway.listTables(base) → filter ชื่อ match ^itec_\d{3}$
        → existing: { partitionNo → tableId }
 └─ 4. loop n = 1..250 (ascending), ภายใต้ guard budget:
        - ถ้า itec_{NNN} ไม่มี → createTable(base, "itec_{NNN}", FIELD_SCHEMA)
        - ถ้ามีแล้ว          → field-list(tableId); ถ้า field ขาด → สร้าง field ที่ขาด
        - เจอ rate-limit (800004135) → backoff + retry (นับรวมใน guard)
 └─ 5. return { total:250, existing, created, remaining, done }
```

**"partition สมบูรณ์" = table มีอยู่ AND มีครบ 41 fields** (ไม่ใช่แค่ table มีชื่อ) → resume ทนแม้ guard ตัดกลาง table

---

## 5. Timeout Guard + Resume

- **Guard:** soft budget (default ~20–25s, config ได้) — หยุด "เริ่ม" partition ใหม่เมื่อ elapsed เกิน budget ก่อน HTTP/proxy timeout → return `done:false` + `remaining`
- **Resume:** เรียกซ้ำ → `listTables` เห็นความจริงว่าทำไปแล้วแค่ไหน → สร้างต่อ
- **No-op cost:** base ที่ครบแล้ว เรียกซ้ำ → field-list 250 table (read) ยืนยันครบ, created=0 (ยอมรับได้เพราะเป็น admin op นาน ๆ ครั้ง; optimize ทีหลังด้วย MySQL cache = ข้าม partition ที่ mark complete แล้ว)

---

## 6. Error Handling

| สถานการณ์ | จัดการ |
|---|---|
| base ไม่เจอ | 404 `base not found` (ไม่สร้างอะไร) |
| rate-limit `800004135` | backoff + retry; ถ้า retry เกินเพดาน → นับเป็น remaining, `done:false` |
| createTable สำเร็จแต่ field ไม่ครบ (guard ตัด/limit) | รอบถัดไป field-list เจอ field ขาด → เติม (field-level idempotency) |
| ชื่อ table ชนกับ non-itec table | filter เฉพาะ `^itec_\d{3}$` — table อื่นในbase ไม่ยุ่ง |

---

## 7. Components (clean architecture)

| ชั้น | ไฟล์ | หน้าที่ |
|---|---|---|
| application | `use-cases/ProvisionYearBase.js` | orchestrate flow §4 (pure, พึ่งแค่ ports) |
| domain | `services/partitionName.js` | `partitionName(n) → "itec_001"`, `PARTITION_COUNT=250` |
| domain (port) | `repositories/LarkGateway.js` | `getBase / listTables / createTable / listFields / createField` |
| infra config | `config/itecFieldSchema.js` | 41 fields + type mapping (§3) |
| infra adapter | `repositories/LarkGatewayHttp.js` | implement port ด้วย Lark API จริง |
| infra web | `web/routes/years.js` + controller | `POST /years` → use-case |

**MySQL write-through** (`sync_partition`, `sync_year`) = **deferred** จนกว่า MySQL (instance B) พร้อม; ออกแบบให้เป็น optional side-effect (ไม่ block Approach A)

---

## 8. Testing

- **unit:** `partitionName` formatting; missing-set computation (existing∖1..250); field-schema mapping; guard logic (fake clock → `done:false` + remaining ถูกต้อง)
- **integration** (test base จริง): empty base → created=250, done=true; เรียกซ้ำ → created=0 (idempotent); ลบ 3 table → เรียกซ้ำ สร้างเฉพาะ 3; base ปลอม → 404

---

## 9. Assumptions / Open items (ต้อง verify ตอนสร้าง adapter)

1. **createTable atomicity (สำคัญสุดต่อ ETA):** raw Lark `create-table` API รับ `fields` inline สร้าง table+41 fields ใน **1 call** ไหม
   - ถ้าใช่ → ~250 call/base ≈ ไม่กี่นาที
   - ถ้าไม่ (per-field เหมือน lark-cli ที่วัดได้ **~22s/table**) → ~250×41 ≈ 1.5–3 ชม./base → guard+resume จำเป็นจริง
2. **listTables pagination** เมื่อ base มี ~250 table (อ่าน, ถูก)
3. **precision ของ number** (money=2, numeric=4, float=2) — ยืนยันกับคนเขียนสูตรว่าพอ
4. **daily base** เป็นอีก endpoint/design แยก (ไม่อยู่ใน spec นี้)
5. **year config** = ค.ศ.; ความสัมพันธ์กับการตัดปีของ source (CrTime เป็น พ.ศ.) เป็นเรื่องของ full sync

---

## 10. Out of scope (spec นี้)

- การเขียน record จริง (full sync ตามปี) — spec แยก
- interval sync ทุก n นาที — spec แยก
- daily base setup — spec แยก
- MySQL write-through — เพิ่มเมื่อ instance B พร้อม
