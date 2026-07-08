import { deriveKey } from '../../domain/services/deriveKey.js';
import { crc32 } from '../../domain/services/checksum.js';
import { transformItecRow } from '../../domain/services/transformItecRow.js';
import { crYear } from '../../domain/services/sourceYear.js';
import { epochMsToUtcDatetimeString, beDatetimeToCeString } from '../../domain/services/dateConversion.js';
import { Mapping } from '../../domain/entities/Mapping.js';
import { YearsNotProvisionedError } from '../../domain/errors.js';

/**
 * One incremental-sync pass (spec §8.B + §8.C, unified). Pulls rows whose
 * `UTime >= watermark` from BOTH `itec` and `daily_itec_temp`, routes each to
 * its yearly base by immutable `CrTime` year, then:
 *   - not in sync_mapping        -> insert (reserve slot + batchCreate)
 *   - in mapping, checksum moved -> update the SAME Lark record (batchUpdate)
 *   - in mapping, checksum equal -> skip (already in sync)
 * Finally advances the watermark to the max UTime processed. Never fetches
 * from Lark to resolve ids (§3) — routing reads sync_mapping only.
 *
 * Synchronous (runs inside the request), not via job_queue: the watermark is
 * itself the checkpoint, so a budget-truncated / crashed run simply resumes
 * from the last stamped watermark on the next call.
 *
 * Crash window (accepted, same trade-off as full-sync §10): if batchCreate
 * succeeds but setState never runs, the next call reprocesses the chunk —
 * updates are idempotent; a re-inserted row collides on (year, source_key)
 * and ON DUPLICATE KEY repoints the mapping (orphaning the first Lark record,
 * left for P5 reconciliation). The watermark is deliberately written LAST so a
 * crash re-does work rather than skipping rows.
 */
export class RunIncrementalSync {
  constructor({ sourceRepository, mappingRepository, yearRepository, defaultSince, chunkSize = 1000, now = Date.now }) {
    this.sourceRepository = sourceRepository;
    this.mappingRepository = mappingRepository;
    this.yearRepository = yearRepository;
    this.defaultSince = defaultSince;
    this.chunkSize = chunkSize;
    this.now = now;
  }

  async execute({ gateway }) {
    const state = await this.mappingRepository.getState('incremental');
    const since = state?.lastUtime ?? this.defaultSince;

    // ONE scan of Com7: pull the whole backlog (UTime >= since) into memory,
    // ordered by UTime asc. All chunking below is in-memory — the source DB is
    // scanned exactly once per call regardless of how many Lark batches result.
    const rows = await this.sourceRepository.fetchChangedSince({ since });
    if (rows.length === 0) {
      return { since, newWatermark: since, scanned: 0, inserted: 0, updated: 0, skipped: 0 };
    }

    // Pre-check: EVERY year present must have a completed base BEFORE we write
    // anything. If any row has nowhere to land, abort the whole sweep without
    // touching Lark, ops mapping, or the watermark — an operator provisions the
    // missing year(s) and re-runs. Never a partial sync.
    const baseByYear = new Map();
    const missingYears = [];
    for (const year of new Set(rows.map((r) => crYear(r)))) {
      const yearRow = await this.yearRepository.getYear(year);
      if (!yearRow || yearRow.status !== 'complete') missingYears.push(year);
      else baseByYear.set(year, yearRow.baseId);
    }
    if (missingYears.length > 0) {
      throw new YearsNotProvisionedError(missingYears.sort((a, b) => a - b));
    }

    // Drain the whole in-memory backlog in this one call, chunkSize rows at a
    // time (Lark batch cap / findByKeys IN-clause size). The watermark is
    // checkpointed after every chunk, so a crash mid-sweep resumes from the
    // last completed chunk instead of redoing everything.
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let newWatermark = since;
    for (let i = 0; i < rows.length; i += this.chunkSize) {
      const chunk = rows.slice(i, i + this.chunkSize);
      const r = await this.#processChunk({ gateway, chunk, baseByYear });
      inserted += r.inserted;
      updated += r.updated;
      skipped += r.skipped;

      // rows are globally sorted by UTime asc -> the chunk's last row is its
      // max. Truncate to whole seconds (sync_state.last_utime is DATETIME):
      // rounds DOWN, safe with the `UTime >= since` query (at worst re-scans a
      // same-second row next run, idempotent skip; never drops one).
      newWatermark = beDatetimeToCeString(chunk[chunk.length - 1].UTime).slice(0, 19);
      await this.mappingRepository.setState('incremental', {
        lastUtime: newWatermark,
        lastRunAt: epochMsToUtcDatetimeString(this.now()),
      });
    }

    return { since, newWatermark, scanned: rows.length, inserted, updated, skipped };
  }

  // Process one in-memory chunk: group by year, route each row to insert /
  // update / skip, and write to Lark + ops. No source-DB access here.
  async #processChunk({ gateway, chunk, baseByYear }) {
    const byYear = new Map();
    for (const row of chunk) {
      const y = crYear(row);
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(row);
    }

    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    for (const [year, yearRows] of byYear) {
      const baseId = baseByYear.get(year);
      const keys = yearRows.map((r) => deriveKey(r));
      const existing = await this.mappingRepository.findByKeys({ year, sourceKeys: keys });

      const toInsert = [];
      const toUpdate = [];
      for (const row of yearRows) {
        const fields = transformItecRow(row);
        const checksum = crc32(JSON.stringify(fields));
        const key = deriveKey(row);
        const cur = existing.get(key);
        if (!cur) toInsert.push({ fields, checksum, key });
        else if (cur.checksum !== checksum) toUpdate.push({ fields, checksum, key, cur });
        else skipped++;
      }

      inserted += await this.#insert({ gateway, year, baseId, items: toInsert });
      updated += await this.#update({ gateway, baseId, items: toUpdate });
    }
    return { inserted, updated, skipped };
  }

  // New rows: reserve partition slots and batchCreate, exactly like backfill
  // (RunFullSyncJob) — a batch may span partitions, so honor the segments.
  async #insert({ gateway, year, baseId, items }) {
    if (items.length === 0) return 0;
    const segments = await this.mappingRepository.reserveSlots({ year, count: items.length });
    const mappings = [];
    let offset = 0;
    for (const seg of segments) {
      const segItems = items.slice(offset, offset + seg.count);
      const recordIds = await gateway.batchCreate({
        baseId, tableId: seg.larkTableId, records: segItems.map((it) => it.fields),
      });
      for (let i = 0; i < recordIds.length; i++) {
        const it = segItems[i];
        mappings.push(new Mapping({
          year, baseId, sourceKey: it.key, partitionNo: seg.partitionNo, larkTableId: seg.larkTableId,
          larkRecordId: recordIds[i], checksum: it.checksum,
          crTime: epochMsToUtcDatetimeString(it.fields.CrTime),
          uTime: epochMsToUtcDatetimeString(it.fields.UTime),
        }));
      }
      const firstOfSeg = mappings[mappings.length - seg.count];
      const lastOfSeg = mappings[mappings.length - 1];
      await this.mappingRepository.updatePartitionBoundary({
        year, partitionNo: seg.partitionNo,
        first: seg.startIndex === 0
          ? { larkRecordId: firstOfSeg.larkRecordId, sourceKey: firstOfSeg.sourceKey, crTime: firstOfSeg.crTime }
          : undefined,
        last: { larkRecordId: lastOfSeg.larkRecordId, sourceKey: lastOfSeg.sourceKey, crTime: lastOfSeg.crTime },
      });
      offset += seg.count;
    }
    await this.mappingRepository.saveMappings(mappings);
    return items.length;
  }

  // Changed rows: batchUpdate the existing Lark record in place (grouped by
  // its table), then refresh checksum/u_time in sync_mapping. No slot reserve,
  // no boundary change — the record stays put.
  async #update({ gateway, baseId, items }) {
    if (items.length === 0) return 0;
    const byTable = new Map();
    for (const it of items) {
      if (!byTable.has(it.cur.larkTableId)) byTable.set(it.cur.larkTableId, []);
      byTable.get(it.cur.larkTableId).push(it);
    }
    const mappings = [];
    for (const [tableId, tableItems] of byTable) {
      await gateway.batchUpdate({
        baseId, tableId,
        records: tableItems.map((it) => ({ recordId: it.cur.larkRecordId, fields: it.fields })),
      });
      for (const it of tableItems) {
        mappings.push(new Mapping({
          year: it.cur.year, baseId, sourceKey: it.key, partitionNo: it.cur.partitionNo,
          larkTableId: it.cur.larkTableId, larkRecordId: it.cur.larkRecordId, checksum: it.checksum,
          crTime: it.cur.crTime, uTime: epochMsToUtcDatetimeString(it.fields.UTime),
        }));
      }
    }
    await this.mappingRepository.saveMappings(mappings);
    return items.length;
  }
}
