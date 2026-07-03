# Lark base/v3 raw API — confirmed shapes (spike, 2026-07-03)

Verified live on `open.larksuite.com`, base `QRqjbxgQ2aqzPksV6MAlhCRvgSd`, bot app.
Envelope for every call: `{ code, msg, data }` — `code === 0` = success.

## Tenant token
```
POST /open-apis/auth/v3/tenant_access_token/internal
body: { app_id, app_secret }
→ { code:0, tenant_access_token:"t-...", expire:<seconds> }   # expire observed ~4169s, NOT always 7200
```
Auth header for all base calls: `Authorization: Bearer <tenant_access_token>`.

## List tables  ⚠️ base/v3 CAPS AT 20 — use bitable/v1 instead
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

## Get base (NOT used)
```
GET /open-apis/base/v3/bases/{base}  → code 99991672 "requires scope base:app:read"  (scope NOT enabled)
```
→ **Do existence via listTables** (uses `base:table:read`, already enabled). `code 91402` = not found.

## Create table  (⭐ ATOMIC with inline fields — confirmed)
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

## List fields  ⚠️ CAPPED AT 20 — cannot enumerate a 41-field table
```
GET /open-apis/base/v3/bases/{base}/tables/{tid}/fields?page_size=100
→ data.fields: [ { id, name, style, type } ]   # returns only 20 items even for a 41-field table
  data.total = 41                              # ← TRUE count is here
  data.has_more = undefined, data.page_token = undefined   # NO pagination token → can't fetch fields 21..41
```
Confirmed live: `page_size=20` and `page_size=100` both return 20 fields, `total:41`, no page_token.
→ **Do not use list-fields to verify field completeness.** Use `data.total` for the count only.
Because create-table is atomic (below), provisioning treats **table-exists ⇒ complete** and skips field enumeration.

## Create field  (resume path)
```
POST /open-apis/base/v3/bases/{base}/tables/{tid}/fields
body: <field def>            # e.g. { "type":"text", "name":"Comment" }
→ code 0, data { id, name, style, type }
```

## Delete table (test cleanup)
```
DELETE /open-apis/base/v3/bases/{base}/tables/{tid}  → code 0
```

## Adapter adjustments vs plan Task 5
- `listTables`: parse `data.tables` (key `id`, `name`); pagination `data.page_token`/`data.has_more`.
- `getBase`: implement via listTables; `code 91402` → `BaseNotFoundError`; `code 0` → exists.
- `createTable`: flat body `{ name, fields }`; return `data.id`.
- `listFields`: parse `data.fields` (`name`).
- `createField`: POST field def directly.
