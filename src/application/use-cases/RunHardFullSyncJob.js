/**
 * Hard full sync (disaster recovery) — the CLEAR phase, then hand off to a
 * normal `full_sync` job for the rebuild (spec: docs/superpowers/plans/
 * 2026-07-08-hard-full-sync.md). For a year whose Lark data is corrupted
 * beyond surgical heal, this:
 *   1. empties every partition table on Lark — deletes the ids we know from
 *      sync_mapping, then sweeps whatever remains via listRecordIds (orphans),
 *      checkpointing per partition so a crash resumes mid-clear;
 *   2. wipes the ops side for the year (mapping rows, partition fill_counts +
 *      boundaries, the full_sync checkpoint) — but KEEPS the Lark tables and
 *      their manual formulas (only records are deleted);
 *   3. enqueues a fresh `full_sync` job so the existing backfill engine
 *      re-populates the year from Com7.
 * Destructive + long: runs on the worker, resumable, creds in job payload.
 */
export class RunHardFullSyncJob {
  constructor({
    mappingRepository, yearRepository, jobQueue, enqueueFullSync,
    tokenCache, createGateway, baseDomain,
    deleteChunkSize = 500, maxAttempts = 5, retryDelayMs = 60000, now = Date.now,
  }) {
    this.mappingRepository = mappingRepository;
    this.yearRepository = yearRepository;
    this.jobQueue = jobQueue;
    this.enqueueFullSync = enqueueFullSync;
    this.tokenCache = tokenCache;
    this.createGateway = createGateway;
    this.baseDomain = baseDomain;
    this.deleteChunkSize = deleteChunkSize;
    this.maxAttempts = maxAttempts;
    this.retryDelayMs = retryDelayMs;
    this.now = now;
  }

  async execute(job) {
    const { id, year, attempts, payload } = job;
    const { appId, appSecret } = payload;
    const scope = `hard_full:${year}`;

    try {
      const { baseId } = await this.yearRepository.getYear(year);
      const state = await this.mappingRepository.getState(scope);
      const fromPartition = state?.checkpoint ?? 0; // partitions <= this are already cleared

      const partitions = await this.mappingRepository.listPartitions({ year });
      for (const p of partitions) {
        if (p.partitionNo <= fromPartition) continue;

        // A fresh token per partition — the clear can run for a long time.
        const token = await this.tokenCache.getToken(appId, appSecret);
        const gateway = this.createGateway({ token, baseDomain: this.baseDomain });

        // (a) delete the records we have mapped (bulk, no Lark read needed)…
        const mapped = await this.mappingRepository.getMappingsForPartition({ year, partitionNo: p.partitionNo });
        await this.#deleteAll(gateway, baseId, p.larkTableId, mapped.map((m) => m.larkRecordId));
        // …(b) then sweep anything still on the table (orphans mapping didn't know about).
        const remaining = await gateway.listRecordIds({ baseId, tableId: p.larkTableId });
        await this.#deleteAll(gateway, baseId, p.larkTableId, remaining);

        await this.mappingRepository.setState(scope, { checkpoint: p.partitionNo });
      }

      // Lark tables are empty — wipe the ops side (records only; tables stay).
      await this.mappingRepository.clearYearMappings({ year });
      await this.mappingRepository.resetPartitionsForYear({ year });
      // Reset the backfill checkpoint so the rebuild starts from scratch
      // (clearState, not setState — setState COALESCEs and can't null a field).
      await this.mappingRepository.clearState({ scope: `full_sync:${year}` });

      // Phase 2: reuse the normal backfill engine.
      await this.enqueueFullSync.execute({ year, appId, appSecret });

      await this.mappingRepository.clearState({ scope }); // done — drop our own checkpoint
      await this.jobQueue.complete({ id, payload: { appId } }); // scrub appSecret
    } catch (err) {
      if (attempts >= this.maxAttempts) {
        console.error(`[RunHardFullSyncJob] job ${id} attempt ${attempts}/${this.maxAttempts} -> dead:`, err);
        await this.jobQueue.fail({ id, payload: { appId } });
      } else {
        console.error(`[RunHardFullSyncJob] job ${id} attempt ${attempts}/${this.maxAttempts} -> retry:`, err);
        await this.jobQueue.retry({ id, runAfter: new Date(this.now() + this.retryDelayMs) });
      }
      throw err;
    }
  }

  // Delete record ids in batches of deleteChunkSize; never call batchDelete
  // with an empty list.
  async #deleteAll(gateway, baseId, tableId, recordIds) {
    for (let i = 0; i < recordIds.length; i += this.deleteChunkSize) {
      const ids = recordIds.slice(i, i + this.deleteChunkSize);
      if (ids.length === 0) continue;
      await gateway.batchDelete({ baseId, tableId, recordIds: ids });
    }
  }
}
