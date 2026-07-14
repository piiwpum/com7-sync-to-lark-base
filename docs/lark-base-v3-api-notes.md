# Lark base/v3 raw API — confirmed shapes (spike, 2026-07-03)

Verified live on `open.larksuite.com`, base `QRqjbxgQ2aqzPksV6MAlhCRvgSd`, bot app.
Envelope for every call: `{ code, msg, data }` — `code === 0` = success.

> **หมายเหตุเอกสารอ้างอิง:** หลายเส้นในโค้ดใช้พาธ `base/v3` ที่ยืนยันจาก spike จริง  
> เอกสารสาธารณะของ Lark ส่วนใหญ่ยังเผยแพร่ตระกูล **`bitable/v1`**  
> ในแต่ละส่วนด้านล่างจะใส่ลิงก์อ้างอิง + **rate-limit / batch size** จากเอกสารอย่างเป็นทางการ (และค่าที่ยืนยันในโปรเจกต์เมื่อมี)

### สรุป Limits แบบรวดเร็ว

| API | Rate-limit (เอกสาร) | Batch / page size | หมายเหตุ |
|---|---|---|---|
| Tenant token | ไม่ระบุเป็น ครั้ง/วินาที | 1 token / call | อายุสูงสุด ~2 ชม. |
| List tables (`bitable/v1`) | **20 ครั้ง/วินาที** | `page_size` สูงสุด **100** | `base/v3` list จำกัด ~20 รายการ ไม่มี pagination |
| Get base | **20 ครั้ง/วินาที** | — | โปรเจกต์ไม่ใช้ (ใช้ listTables แทน) |
| Create table | **10 ครั้ง/วินาที** (จาก bitable/v1 doc) | 1 table / call (+ ฟิลด์แนบได้) | พาธจริงเป็น `base/v3` |
| List fields | **20 ครั้ง/วินาที** | `page_size` สูงสุด **100** (`bitable/v1`) | `base/v3` spike คืนได้แค่ 20 รายการ |
| Create field | **10 ครั้ง/วินาที** | 1 field / call | — |
| Delete table | **10 ครั้ง/วินาที** | 1 table / call | — |
| **batch_create** | **50 ครั้ง/วินาที** | **1,000** records / call | ยืนยัน live ในโปรเจกต์แล้ว (อย่าสับสนกับค่า 500 ของเส้นอื่น) |
| **batch_update** | **50 ครั้ง/วินาที** | **1,000** records / call | — |
| **batch_delete** | **50 ครั้ง/วินาที** | **500** records / call | — |
| list / count records | **20 ครั้ง/วินาที** | `page_size` สูงสุด **500** | — |

อ้างอิงภาพรวม rate-limit: [Frequency control](https://open.larksuite.com/document/ukTMukTMukTM/uUzN04SN3QjL1cDN)

> เขียนลงตารางเดียวกันพร้อมกันมักได้ `1254291` (write conflict) — Lark ไม่รองรับ concurrent write ต่อ table

---

## Tenant token

**Reference:** [Obtain tenant_access_token (custom app)](https://open.larksuite.com/document/ukTMukTMukTM/ukDNz4SO0MjL5QzM/auth-v3/auth/tenant_access_token_internal)

| | |
|---|---|
| **Rate-limit** | ไม่ระบุเป็น “ครั้ง/วินาที” ในเอกสารนี้ |
| **Batch size** | ไม่มี (แลก token ทีละครั้ง) |
| **อายุ token** | สูงสุดประมาณ **2 ชั่วโมง** (`expire` เป็นวินาที; spike สังเกต ~4169 ไม่จำเป็นต้องเป็น 7200 เสมอ) |

```
POST /open-apis/auth/v3/tenant_access_token/internal
body: { app_id, app_secret }
→ { code:0, tenant_access_token:"t-...", expire:<seconds> }
```
Auth header for all base calls: `Authorization: Bearer <tenant_access_token>`.

---

## List tables  ⚠️ base/v3 CAPS AT 20 — use bitable/v1 instead

**Reference (ใช้จริงในโปรเจกต์):** [List all tables — bitable/v1](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/bitable-v1/app-table/list)

| | `base/v3` (spike) | `bitable/v1` (เอกสาร + ใช้จริง) |
|---|---|---|
| **Rate-limit** | ไม่มีหน้าเอกสารแยก | **20 ครั้ง/วินาที** |
| **Batch / page size** | คืนได้สูงสุด ~**20** รายการ, **ไม่มี** `page_token` | `page_size` สูงสุด **100** + pagination |

```
GET /open-apis/base/v3/bases/{base}/tables?page_size=100
→ data.tables:[{id,name}], data.total  BUT returns only 20 items, no page_token
   (confirmed live: 37 tables in base → returns 20, has_more/page_token undefined) → CANNOT enumerate >20
```
**Use bitable/v1 to list tables** (honors page_size, paginates properly — 53 tables returned in one page):
```
GET /open-apis/bitable/v1/apps/{base}/tables?page_size=100[&page_token=...]
→ data.items:[{ table_id, name }], data.has_more, data.page_token   # key `items` + `table_id`
```
(base/v3 tables?page_size=1 is still fine for the existence check — bad base → code 91402 "NOTEXIST".)
Creating a table whose name already exists → code **800010102** "validation_error" (duplicate).

---

## Get base (NOT used)

**Reference (เทียบเคียง bitable/v1):** [Get Base — bitable/v1](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/bitable-v1/app/get)

| | |
|---|---|
| **Rate-limit** | **20 ครั้ง/วินาที** (เอกสาร bitable/v1 get) |
| **Batch size** | — (อ่าน base เดียวต่อ call) |

```
GET /open-apis/base/v3/bases/{base}  → code 99991672 "requires scope base:app:read"  (scope NOT enabled)
```
→ **Do existence via listTables** (uses `base:table:read`, already enabled). `code 91402` = not found.

---

## Create table  (⭐ ATOMIC with inline fields — confirmed)

**Reference:**
- พาธที่โปรเจกต์ใช้ (`base/v3`) — ยังไม่มีเอกสารสาธารณะแยกที่ตรงพาธนี้; ยืนยันจาก spike ในไฟล์นี้
- เอกสารสาธารณะที่ใกล้เคียง (พาธและ body ต่างกัน — **อย่าสลับใช้ตรง ๆ**): [Create a table — bitable/v1](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/bitable-v1/app-table/create)

| | |
|---|---|
| **Rate-limit** | **10 ครั้ง/วินาที** (อ้างอิงเอกสาร bitable/v1 create table; `base/v3` ไม่มีหน้าเอกสารแยก) |
| **Batch size** | **1 table / call** (แนบฟิลด์เริ่มต้นได้ใน body เดียวกัน — โปรเจกต์ยืนยันสร้าง 41 ฟิลด์แบบ atomic ได้) |

```
POST /open-apis/base/v3/bases/{base}/tables
body: { "name":"itec_001", "fields":[ <field defs> ] }   # FLAT body — NOT { table:{...} } (that's bitable v1 → 800010701)
→ data.id = "tbl..."      # table id key is `id`
```
Confirmed live with the full 41-field schema: create returns `code 0` and the table has `total:41` fields → **atomic, 1 API call per table** (≈ minutes for 250, not hours). (list-fields only shows 20 of them — see caveat below — but they all exist.)

Field def shape (same as verified via lark-cli):
- text:     `{ "type":"text", "name":"Product" }`
- number:   `{ "type":"number", "name":"SellID", "style":{ "type":"plain", "precision":0 } }`
- datetime: `{ "type":"datetime", "name":"CrTime", "style":{ "format":"yyyy-MM-dd HH:mm" } }`

แนวทางฟิลด์เพิ่มเติม: [Field edit development guide](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/bitable-v1/app-table-field/guide)

---

## List fields  ⚠️ CAPPED AT 20 — cannot enumerate a 41-field table

**Reference (เทียบเคียง bitable/v1):** [List fields — bitable/v1](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/bitable-v1/app-table-field/list)

> พาธที่ spike: `GET /open-apis/base/v3/bases/{base}/tables/{tid}/fields`  
> เอกสารสาธารณะใช้: `GET /open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/fields`

| | `base/v3` (spike) | `bitable/v1` (เอกสาร) |
|---|---|---|
| **Rate-limit** | ไม่มีหน้าเอกสารแยก | **20 ครั้ง/วินาที** |
| **Batch / page size** | คืนได้แค่ ~**20** ฟิลด์แม้ตั้ง `page_size=100` | `page_size` สูงสุด **100** |

```
GET /open-apis/base/v3/bases/{base}/tables/{tid}/fields?page_size=100
→ data.fields: [ { id, name, style, type } ]   # returns only 20 items even for a 41-field table
  data.total = 41                              # ← TRUE count is here
  data.has_more = undefined, data.page_token = undefined   # NO pagination token → can't fetch fields 21..41
```
Confirmed live: `page_size=20` and `page_size=100` both return 20 fields, `total:41`, no page_token.
→ **Do not use list-fields to verify field completeness.** Use `data.total` for the count only.
Because create-table is atomic (below), provisioning treats **table-exists ⇒ complete** and skips field enumeration.

---

## Create field  (resume path)

**Reference (เทียบเคียง bitable/v1):** [Create field — bitable/v1](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/bitable-v1/app-table-field/create)

> พาธที่ spike: `POST /open-apis/base/v3/bases/{base}/tables/{tid}/fields`  
> เอกสารสาธารณะใช้: `POST /open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/fields`  
> รูปแบบ body ของ `base/v3` ใน spike เป็น field def แบบ string type (`text`/`number`/…) ซึ่งต่างจากตัวเลข type ของ bitable/v1 ในเอกสาร

| | |
|---|---|
| **Rate-limit** | **10 ครั้ง/วินาที** |
| **Batch size** | **1 field / call** |

```
POST /open-apis/base/v3/bases/{base}/tables/{tid}/fields
body: <field def>            # e.g. { "type":"text", "name":"Comment" }
→ code 0, data { id, name, style, type }
```

---

## Delete table (test cleanup)

**Reference (เทียบเคียง bitable/v1):** [Delete a table — bitable/v1](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/bitable-v1/app-table/delete)

> พาธที่ spike: `DELETE /open-apis/base/v3/bases/{base}/tables/{tid}`  
> เอกสารสาธารณะใช้: `DELETE /open-apis/bitable/v1/apps/{app_token}/tables/{table_id}`

| | |
|---|---|
| **Rate-limit** | **10 ครั้ง/วินาที** |
| **Batch size** | **1 table / call** |

```
DELETE /open-apis/base/v3/bases/{base}/tables/{tid}  → code 0
```

---

## Related references (โปรเจกต์ใช้เพิ่มจากเส้นข้างบน)

เส้นเหล่านี้ไม่ได้อยู่ใน spike เดิมของไฟล์นี้ แต่ถูกใช้ใน `LarkGatewayHttp` ภายหลัง:

### batch_create — สร้างเรคอร์ด

**Reference:** [Create records](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/bitable-v1/app-table-record/batch_create)

| | |
|---|---|
| **Endpoint** | `POST /open-apis/bitable/v1/apps/{baseId}/tables/{tableId}/records/batch_create` |
| **Rate-limit** | **50 ครั้ง/วินาที** |
| **Batch size** | **1,000** records / call |

โปรเจกต์ยืนยัน live แล้วว่าส่งครบ 1,000/ครั้งได้ และลำดับ `record_id` ตามอินพุต  
(อย่าสับสนกับ **batch_delete = 500** หรือข้อความ error เก่าบางจุดที่เคยเขียน 500 สำหรับการเพิ่ม)

### batch_update — อัปเดตเรคอร์ด

**Reference:** [Update records](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/bitable-v1/app-table-record/batch_update)

| | |
|---|---|
| **Endpoint** | `POST /open-apis/bitable/v1/apps/{baseId}/tables/{tableId}/records/batch_update` |
| **Rate-limit** | **50 ครั้ง/วินาที** |
| **Batch size** | **1,000** records / call |

### batch_delete — ลบเรคอร์ด

**Reference:** [Delete records](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/bitable-v1/app-table-record/batch_delete)

| | |
|---|---|
| **Endpoint** | `POST /open-apis/bitable/v1/apps/{baseId}/tables/{tableId}/records/batch_delete` |
| **Rate-limit** | **50 ครั้ง/วินาที** |
| **Batch size** | **500** records / call |

### list / count records

**Reference:** [List records](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/bitable-v1/app-table-record/list)

| | |
|---|---|
| **Endpoint** | `GET /open-apis/bitable/v1/apps/{baseId}/tables/{tableId}/records` |
| **Rate-limit** | **20 ครั้ง/วินาที** |
| **Batch / page size** | `page_size` สูงสุด **500** |

ในโปรเจกต์:
- `countRecords` → `page_size=1` แล้วอ่าน `data.total`
- `listRecordIds` → paginate ด้วย `page_size=500`

| ภาพรวม | [Bitable overview](https://open.larksuite.com/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/bitable-overview) |

---

## Adapter adjustments vs plan Task 5
- `listTables`: parse `data.tables` (key `id`, `name`); pagination `data.page_token`/`data.has_more`.
- `getBase`: implement via listTables; `code 91402` → `BaseNotFoundError`; `code 0` → exists.
- `createTable`: flat body `{ name, fields }`; return `data.id`.
- `listFields`: parse `data.fields` (`name`).
- `createField`: POST field def directly.
