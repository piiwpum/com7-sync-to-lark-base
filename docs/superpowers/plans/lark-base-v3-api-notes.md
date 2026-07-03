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

## List tables  (also used as base-existence check)
```
GET /open-apis/base/v3/bases/{base}/tables?page_size=100[&page_token=...]
→ data.tables: [ { id:"tbl...", name:"..." } ]      # key is `tables` + `id` (NOT items/table_id)
  data.total, data.has_more, data.page_token
bad base token → code 91402 "NOTEXIST"              # ← map to BaseNotFoundError (404)
```

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
list-fields on the new table returned all inline fields in ONE call → **1 API call per table** (≈ minutes for 250, not hours).

Field def shape (same as verified via lark-cli):
- text:     `{ "type":"text", "name":"Product" }`
- number:   `{ "type":"number", "name":"SellID", "style":{ "type":"plain", "precision":0 } }`
- datetime: `{ "type":"datetime", "name":"CrTime", "style":{ "format":"yyyy-MM-dd HH:mm" } }`

## List fields  (resume path)
```
GET /open-apis/base/v3/bases/{base}/tables/{tid}/fields?page_size=100[&page_token=...]
→ data.fields: [ { id, name, style, type } ]        # key `fields` + `name`
  data.total, data.has_more, data.page_token
```

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
