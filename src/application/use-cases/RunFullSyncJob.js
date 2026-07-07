// src/application/use-cases/RunFullSyncJob.js
import { deriveKey } from '../../domain/services/deriveKey.js';
import { crc32 } from '../../domain/services/checksum.js';
import { transformItecRow } from '../../domain/services/transformItecRow.js';
import { epochMsToUtcDatetimeString } from '../../domain/services/dateConversion.js';
import { Mapping } from '../../domain/entities/Mapping.js';

/**
 * Runs one full-sync (backfill) job to completion: loops chunks of
 * `chunkSize` rows from Com7, reserves partition slots, batch-creates into
 * Lark, writes sync_mapping, and checkpoints sync_state after every chunk
 * (spec §3). A fresh Lark token is fetched per chunk via `tokenCache` (which
 * only re-exchanges near expiry) so the job can run for hours. On an
 * unrecoverable error: retries with backoff below `maxAttempts`, else marks
 * the job permanently dead. Either way the app_secret is scrubbed from the
 * job's payload — it's only meaningful while the job is actively running.
 */
export class RunFullSyncJob {
  constructor({
    sourceRepository, mappingRepository, yearRepository, jobQueue,
    tokenCache, createGateway, baseDomain,
    chunkSize = 1000, maxAttempts = 5, retryDelayMs = 60000, now = Date.now,
  }) {
    this.sourceRepository = sourceRepository;
    this.mappingRepository = mappingRepository;
    this.yearRepository = yearRepository;
    this.jobQueue = jobQueue;
    this.tokenCache = tokenCache;
    this.createGateway = createGateway;
    this.baseDomain = baseDomain;
    this.chunkSize = chunkSize;
    this.maxAttempts = maxAttempts;
    this.retryDelayMs = retryDelayMs;
    this.now = now;
  }

  async execute(job) {
    const { id, year, attempts, payload } = job;
    const { appId, appSecret } = payload;
    const scope = `full_sync:${year}`;

    try {
      const { baseId } = await this.yearRepository.getYear(year);
      const state = await this.mappingRepository.getState(scope);
      let cursor = state?.checkpoint ?? null;

      // The checkpoint (sync_state) is deliberately written LAST in this loop,
      // after the Lark write (batchCreate) and the mapping write (saveMappings)
      // have both completed. If the worker crashes between batchCreate
      // succeeding and this chunk's checkpoint being saved, re-running the job
      // will re-fetch and re-process the same chunk: it burns a second
      // reserveSlots reservation (the crashed attempt's fill_count increment
      // already committed, so that capacity is permanently wasted) and creates
      // a second Lark record for the same rows (ON DUPLICATE KEY UPDATE on
      // source_key repoints the mapping at the newer record, orphaning the
      // first). This is a known, accepted trade-off (spec: duplicate Lark
      // records in a narrow crash window, deferred to a future P5
      // reconciliation phase) — do NOT "fix" it by moving the checkpoint
      // write earlier, since that would trade rare duplicates for silently
      // LOST rows on a crash, which is strictly worse. See docs/sync-architecture.md §10.
      for (;;) {
        const rows = await this.sourceRepository.fetchItecChunk({ year, afterCursor: cursor, limit: this.chunkSize });
        if (rows.length === 0) break;

        const transformedRows = rows.map((r) => transformItecRow(r));
        const sourceKeys = rows.map((r) => deriveKey(r));
        const checksums = transformedRows.map((t) => crc32(JSON.stringify(t)));

        const token = await this.tokenCache.getToken(appId, appSecret);
        const gateway = this.createGateway({ token, baseDomain: this.baseDomain });

        const segments = await this.mappingRepository.reserveSlots({ year, count: rows.length });
        const mappings = [];
        let offset = 0;
        for (const seg of segments) {
          const segTransformed = transformedRows.slice(offset, offset + seg.count);
          const recordIds = await gateway.batchCreate({
            baseId, tableId: seg.larkTableId, records: segTransformed,
          });
          for (let i = 0; i < recordIds.length; i++) {
            const idx = offset + i;
            mappings.push(new Mapping({
              year, baseId, sourceKey: sourceKeys[idx], partitionNo: seg.partitionNo, larkTableId: seg.larkTableId,
              larkRecordId: recordIds[i], checksum: checksums[idx],
              crTime: epochMsToUtcDatetimeString(transformedRows[idx].CrTime),
              uTime: epochMsToUtcDatetimeString(transformedRows[idx].UTime),
            }));
          }

          // seg.startIndex===0 means this segment's first row is the partition's
          // very first record ever written (§7); the segment's last row is
          // always this partition's most-recent record so far.
          const firstOfSeg = mappings[mappings.length - seg.count];
          const lastOfSeg = mappings[mappings.length - 1];
          await this.mappingRepository.updatePartitionBoundary({
            year, partitionNo: seg.partitionNo,
            first: seg.startIndex === 0 ? { larkRecordId: firstOfSeg.larkRecordId, sourceKey: firstOfSeg.sourceKey, crTime: firstOfSeg.crTime } : undefined,
            last: { larkRecordId: lastOfSeg.larkRecordId, sourceKey: lastOfSeg.sourceKey, crTime: lastOfSeg.crTime },
          });

          offset += seg.count;
        }

        await this.mappingRepository.saveMappings(mappings);

        const last = rows[rows.length - 1];
        cursor = { sellId: last.SellID, rowNo: last.RowNo };
        await this.mappingRepository.setState(scope, { checkpoint: cursor, lastRunAt: epochMsToUtcDatetimeString(this.now()) });
      }

      await this.jobQueue.complete({ id, payload: { appId } }); // scrub appSecret
    } catch (err) {
      if (attempts >= this.maxAttempts) {
        console.error(`[RunFullSyncJob] job ${id} attempt ${attempts}/${this.maxAttempts} -> dead:`, err);
        await this.jobQueue.fail({ id, payload: { appId } });
      } else {
        console.error(`[RunFullSyncJob] job ${id} attempt ${attempts}/${this.maxAttempts} -> retry:`, err);
        await this.jobQueue.retry({ id, runAfter: new Date(this.now() + this.retryDelayMs) });
      }
      throw err;
    }
  }
}
