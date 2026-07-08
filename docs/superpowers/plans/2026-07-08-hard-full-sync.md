# Hard Full Sync (nuke & rebuild a year) Implementation Plan

> Disaster-recovery endpoint: when a year's data on Lark is corrupted beyond
> surgical heal, wipe the year clean and re-backfill from Com7.
> Decisions locked with owner (2026-07-08): delete via mapping-first + Lark
> list-sweep; background job; confirm-only guard; whole-year scope.

---

## Goal

```
POST /sync/hard-full { year, confirm:true }   (auth headers)
  Phase 1 CLEAR (this job):
    for each partition table of the year:
       (a) delete records by lark_record_id from sync_mapping   (bulk, fast)
       (b) listRecordIds from Lark -> delete the remainder      (orphan sweep, authoritative)
       checkpoint per partition (resumable)
    clear sync_mapping WHERE year
    reset sync_partition (fill_count=0, boundaries NULL) — KEEP lark_table_id pointers
    reset sync_state full_sync:<year>
  Phase 2 REBACKFILL:
    enqueue a normal `full_sync` job for the year -> existing worker backfills it
```

**Why Phase 2 = reuse full_sync:** the backfill engine (`RunFullSyncJob`) is
done and battle-tested. Hard-full only adds the CLEAR phase, then hands off.

**Why never drop the tables:** Decision #4 — users hand-write Lark formulas on
all 250 partition tables. Dropping loses them. We empty records, keep tables +
fields + formulas. Formulas reference fields, not record ids, so they survive a
clear+rebuild.

---

## Global Constraints

- TDD every task (fail → implement → pass → commit).
- **Destructive** — deletes real Lark records. Guard: require `confirm:true`;
  run as a resumable background job so a crash never leaves a half-state that
  can't be finished by re-running.
- One-way (never write Com7). Reuse: `batchDelete`, `listRecordIds`,
  `getMappingsForPartition`, `listPartitions`, `EnqueueFullSync`,
  `RunFullSyncJob`.
- Lark creds travel in `job_queue.payload` (like full_sync) so the long job
  keeps refreshing its own token.

## Gaps to build

| # | thing | status |
|---|---|---|
| 1 | worker dispatch by `job.type` | worker runs `RunFullSyncJob` for EVERY job today |
| 2 | `MappingRepository.clearYearMappings(year)` | new |
| 3 | `MappingRepository.resetPartitionsForYear(year)` | new (fill_count=0 + boundaries NULL, keep table_id) |
| 4 | `RunHardFullSyncJob` (clear phase + enqueue full_sync) | new |
| 5 | `EnqueueHardFullSync` + route/controller + confirm guard | new |

---

## Task 1: MySQL clear methods

**Files:** `MappingRepositoryMysql.js`, `MappingRepository.js` (port), test.

- [ ] `clearYearMappings({ year })` → `DELETE FROM sync_mapping WHERE year=?`
      (year is the LIST-partition key; a plain DELETE is fine for a rare op).
- [ ] `resetPartitionsForYear({ year })` → `UPDATE sync_partition SET
      fill_count=0, first_lark_record_id=NULL, first_source_key=NULL,
      first_cr_time=NULL, last_lark_record_id=NULL, last_source_key=NULL,
      last_cr_time=NULL WHERE year=?` (KEEP lark_table_id — tables still exist).
- [ ] TDD via fake pool (assert SQL + params). Commit.

## Task 2: worker dispatches by job.type

**Files:** `worker.js`, wiring; no new test infra (worker is the composition
edge — cover the dispatch with a tiny unit if practical, else manual note).

- [ ] Build both `runFullSyncJob` and `runHardFullSyncJob`.
- [ ] In the claim loop: `switch (job.type) { case 'full_sync': ...; case
      'hard_full_sync': ...; default: log+fail }`.
- [ ] Commit.

## Task 3: `RunHardFullSyncJob` (clear phase)

**Files:** `RunHardFullSyncJob.js`, test (fakes).

- [ ] **Step 1: failing tests** covering:
  1. resumes from `sync_state['hard_full:<year>'].checkpoint` (last cleared partition)
  2. per partition: deletes mapping record_ids first (chunked ≤500), then
     listRecordIds → deletes the remainder (orphans); checkpoints partition_no
  3. after all partitions: clearYearMappings + resetPartitionsForYear +
     reset full_sync:<year> state
  4. finally enqueues a `full_sync` job for the year (same creds) and completes
  5. crash mid-clear → re-run continues from checkpoint, no double work that
     breaks (batchDelete of an already-gone id is tolerated — see ⚠️)
  6. retry/dead on error with backoff, scrub appSecret (mirror RunFullSyncJob)
- [ ] **Step 3: implement**. Sketch:
  ```js
  async execute(job) {
    const { id, year, attempts, payload } = job;
    const { appId, appSecret } = payload;
    const scope = `hard_full:${year}`;
    try {
      const { baseId } = await this.yearRepository.getYear(year);
      const state = await this.mappingRepository.getState(scope);
      let fromPartition = state?.checkpoint ?? 0;

      const partitions = await this.mappingRepository.listPartitions({ year });
      for (const p of partitions.filter((p) => p.partitionNo > fromPartition)) {
        const token = await this.tokenCache.getToken(appId, appSecret);
        const gw = this.createGateway({ token, baseDomain: this.baseDomain });
        // (a) delete known mapped records
        const mapped = await this.mappingRepository.getMappingsForPartition({ year, partitionNo: p.partitionNo });
        await this.#deleteAll(gw, baseId, p.larkTableId, mapped.map((m) => m.larkRecordId));
        // (b) sweep orphans
        const remaining = await gw.listRecordIds({ baseId, tableId: p.larkTableId });
        await this.#deleteAll(gw, baseId, p.larkTableId, remaining);
        await this.mappingRepository.setState(scope, { checkpoint: p.partitionNo });
      }

      await this.mappingRepository.clearYearMappings({ year });
      await this.mappingRepository.resetPartitionsForYear({ year });
      await this.mappingRepository.setState(`full_sync:${year}`, { checkpoint: null, status: null });

      await this.enqueueFullSync.execute({ year, appId, appSecret }); // Phase 2 hand-off
      await this.mappingRepository.setState(scope, { checkpoint: null, status: 'done' });
      await this.jobQueue.complete({ id, payload: { appId } });
    } catch (err) { /* retry<max else fail; scrub appSecret; rethrow (mirror RunFullSyncJob) */ }
  }
  // #deleteAll: chunk ids by 500, batchDelete each; tolerate "record not found"
  ```
- [ ] Commit.

> ✅ **Verified live (2026-07-08):** Lark `bitable/v1 batch_delete` with a
> non-existent record id returns `{code:0, data:{records:[]}, msg:"success"}` —
> it IGNORES missing ids, no error. So `#deleteAll` is safe as-is on crash-resume
> (re-deleting already-gone ids won't throw); no catch-and-continue needed.

## Task 4: enqueue + route + guard

**Files:** `EnqueueHardFullSync.js`, `SyncController.js`, `routes/sync.js`,
`index.js`, route test.

- [ ] `EnqueueHardFullSync` — mirror `EnqueueFullSync` but `type:'hard_full_sync'`;
      require year provisioned (`sync_year.status==='complete'`); idempotent on
      an existing active hard_full job.
- [ ] Controller `hardFull`: 400 if `year` not int; **403/400 if `confirm !==
      true`** (guard); 404 YearNotProvisioned; else 202 with job summary.
- [ ] Route `POST /sync/hard-full` (larkAuth). Wire in composition root.
- [ ] Commit.

## Task 5: live verify

- [ ] On a **throwaway test base/year**: seed a few records, POST /sync/hard-full
      {year,confirm:true}, watch the job: partition tables emptied, sync_mapping
      for the year gone, fill_count reset, then a full_sync job appears and
      re-backfills. Confirm record ids changed but tables/fields/formulas intact.
- [ ] Verify batchDelete-of-missing-id behavior (the ⚠️ above).

---

## Out of scope

- No `dryRun` (owner: confirm-only).
- No partition-level scope (whole year only).
- Concurrency lock vs incremental/full-sync on the same year during rebuild —
  note as a risk; hard-full is a deliberate manual op, operator should pause
  other triggers. A per-year lock can come with the §10 midnight state machine.
