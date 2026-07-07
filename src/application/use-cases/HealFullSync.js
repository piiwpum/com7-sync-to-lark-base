import { YearNotProvisionedError } from '../../domain/errors.js';
import { deriveKey } from '../../domain/services/deriveKey.js';
import { crc32 } from '../../domain/services/checksum.js';
import { transformItecRow } from '../../domain/services/transformItecRow.js';
import { epochMsToUtcDatetimeString } from '../../domain/services/dateConversion.js';
import { Mapping } from '../../domain/entities/Mapping.js';

const scopeFor = (year) => `full_sync_heal:${year}`;
const BATCH_CREATE_CAP = 1000; // bitable/v1 confirmed cap
const BATCH_DELETE_CAP = 500; // bitable/v1 confirmed cap

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Reconciliation L3 heal (§9): self-contained, idempotent repair for a
 * year's drift. Always corrects `fill_count` bookkeeping (cheap, no Lark
 * call) AND always does the full deep-verify (listing every real Lark
 * record id and diffing against sync_mapping by identity, not just count).
 *
 * Deliberately does NOT use `CheckFullSync`'s cheap `countRecords`-only
 * screen as a gate here: an orphan and a missing record can cancel out
 * numerically (one extra + one lost = the same total), which a count-only
 * comparison cannot see but a real record-id diff catches immediately.
 * Since heal's whole purpose is to be the authoritative fix, it pays the
 * full listRecordIds cost on every partition rather than risk that blind
 * spot. Unlike the regular sync path, this IS allowed to fetch/delete real
 * Lark records (per docs/sync-architecture.md §9's L3 tier).
 */
export class HealFullSync {
  constructor({ sourceRepository, mappingRepository, yearRepository, now = Date.now }) {
    this.sourceRepository = sourceRepository;
    this.mappingRepository = mappingRepository;
    this.yearRepository = yearRepository;
    this.now = now;
  }

  async execute({ gateway, year, budgetMs }) {
    const yearRow = await this.yearRepository.getYear(year);
    if (!yearRow || yearRow.status !== 'complete') throw new YearNotProvisionedError(year);
    const { baseId } = yearRow;

    const partitions = await this.mappingRepository.listPartitions({ year });
    const state = await this.mappingRepository.getState(scopeFor(year));
    const lastPartitionOverall = partitions.at(-1)?.partitionNo ?? 0;
    // A checkpoint whose cursor already reached the last partition means the
    // PREVIOUS heal run finished — this call is a fresh one (new drift may
    // have appeared since), not a continuation, so start over rather than
    // treating "already done" as "nothing left to do".
    const priorRunDone = state?.checkpoint && state.checkpoint.lastPartitionNo >= lastPartitionOverall;
    const checkpoint = (!state?.checkpoint || priorRunDone)
      ? { lastPartitionNo: 0, actionsTaken: [] }
      : state.checkpoint;
    let lastPartitionNo = checkpoint.lastPartitionNo;
    const actionsTaken = [...checkpoint.actionsTaken];

    const start = this.now();
    const budgetLeft = () => this.now() - start < budgetMs;

    for (const p of partitions) {
      if (p.partitionNo <= lastPartitionNo) continue;
      if (!budgetLeft()) break;

      const mapped = await this.mappingRepository.getMappingsForPartition({ year, partitionNo: p.partitionNo });
      const mappedCount = mapped.length;

      // Always safe, no Lark call: bookkeeping-only drift like the one found
      // by hand this session (reserveSlots committed capacity for a chunk
      // whose batchCreate never actually ran).
      if (p.fillCount !== mappedCount) {
        await this.mappingRepository.setFillCount({ year, partitionNo: p.partitionNo, fillCount: mappedCount });
      }

      let orphansDeleted = 0;
      let recordsRecreated = 0;

      const actualIds = await gateway.listRecordIds({ baseId, tableId: p.larkTableId });
      const actualIdSet = new Set(actualIds);
      const mappedIdSet = new Set(mapped.map((m) => m.larkRecordId));

      const orphans = actualIds.filter((id) => !mappedIdSet.has(id));
      for (const batch of chunk(orphans, BATCH_DELETE_CAP)) {
        const deleted = await gateway.batchDelete({ baseId, tableId: p.larkTableId, recordIds: batch });
        orphansDeleted += deleted.length;
      }

      const missing = mapped.filter((m) => !actualIdSet.has(m.larkRecordId));
      if (missing.length > 0) {
        const rows = await this.sourceRepository.fetchBySourceKeys({ sourceKeys: missing.map((m) => m.sourceKey) });
        const rowBySourceKey = new Map(rows.map((r) => [deriveKey(r), r]));

        // A source_key with no matching row means Com7 physically deleted
        // it (open question §11 #2) — nothing to recreate from, so it's
        // silently skipped rather than left as an unresolvable mapping.
        const toRecreate = missing.map((m) => rowBySourceKey.get(m.sourceKey)).filter(Boolean);
        for (const batch of chunk(toRecreate, BATCH_CREATE_CAP)) {
          const transformed = batch.map((r) => transformItecRow(r));
          const checksums = transformed.map((t) => crc32(JSON.stringify(t)));
          const recordIds = await gateway.batchCreate({ baseId, tableId: p.larkTableId, records: transformed });
          const mappings = batch.map((r, i) => new Mapping({
            year, baseId, sourceKey: deriveKey(r), partitionNo: p.partitionNo, larkTableId: p.larkTableId,
            larkRecordId: recordIds[i], checksum: checksums[i],
            crTime: epochMsToUtcDatetimeString(transformed[i].CrTime),
            uTime: epochMsToUtcDatetimeString(transformed[i].UTime),
          }));
          await this.mappingRepository.saveMappings(mappings);
          recordsRecreated += recordIds.length;
        }
      }

      if (orphansDeleted > 0 || recordsRecreated > 0) {
        actionsTaken.push({ partitionNo: p.partitionNo, larkTableId: p.larkTableId, orphansDeleted, recordsRecreated });
      }
      lastPartitionNo = p.partitionNo;
    }

    const done = partitions.length === 0 || lastPartitionNo >= partitions.at(-1).partitionNo;
    await this.mappingRepository.setState(scopeFor(year), {
      checkpoint: { lastPartitionNo, actionsTaken },
      lastRunAt: epochMsToUtcDatetimeString(this.now()),
    });

    const partitionsProcessed = partitions.filter((p) => p.partitionNo <= lastPartitionNo).length;
    return { year, done, partitionsProcessed, partitionsTotal: partitions.length, actionsTaken };
  }
}
