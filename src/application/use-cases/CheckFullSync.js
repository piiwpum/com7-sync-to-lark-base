import { YearNotProvisionedError } from '../../domain/errors.js';
import { epochMsToUtcDatetimeString } from '../../domain/services/dateConversion.js';

const scopeFor = (year) => `full_sync_check:${year}`;

/**
 * Reconciliation L1 (§9): for each partition of a year, compare the cheap
 * ground truth on both sides — Lark's real record total (1 API call/table,
 * `gateway.countRecords`) vs `sync_mapping`'s row count — against
 * `sync_partition.fill_count`. Read-only; never writes. Resumable across
 * calls via a checkpoint in `sync_state` (mirrors RunFullSyncJob's own
 * checkpoint pattern), since — unlike `POST /base/remove-partitions` —
 * nothing here shrinks between calls to make progress self-evident.
 */
export class CheckFullSync {
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
    // PREVIOUS scan finished — this call is a fresh one (drift may have
    // appeared since), not a continuation, so start over instead of
    // returning the old scan's cached findings untouched.
    const priorScanDone = state?.checkpoint && state.checkpoint.lastPartitionNo >= lastPartitionOverall;
    const checkpoint = (!state?.checkpoint || priorScanDone)
      ? { lastPartitionNo: 0, findings: [], mappedTotal: 0, larkGrandTotal: 0 }
      : state.checkpoint;
    let { lastPartitionNo, mappedTotal, larkGrandTotal } = checkpoint;
    const findings = [...checkpoint.findings];

    const start = this.now();
    const budgetLeft = () => this.now() - start < budgetMs;

    for (const p of partitions) {
      if (p.partitionNo <= lastPartitionNo) continue;
      if (!budgetLeft()) break;

      const mapped = await this.mappingRepository.getMappingsForPartition({ year, partitionNo: p.partitionNo });
      const mappedCount = mapped.length;
      const larkTotal = await gateway.countRecords({ baseId, tableId: p.larkTableId });

      let status = 'ok';
      if (larkTotal !== mappedCount) status = 'lark_drift';
      else if (p.fillCount !== mappedCount) status = 'fill_count_drift';
      if (status !== 'ok') findings.push({ partitionNo: p.partitionNo, larkTableId: p.larkTableId, mappedCount, fillCount: p.fillCount, larkTotal, status });

      mappedTotal += mappedCount;
      larkGrandTotal += larkTotal;
      lastPartitionNo = p.partitionNo;
    }

    const done = partitions.length === 0 || lastPartitionNo >= partitions.at(-1).partitionNo;
    await this.mappingRepository.setState(scopeFor(year), {
      checkpoint: { lastPartitionNo, findings, mappedTotal, larkGrandTotal },
      lastRunAt: epochMsToUtcDatetimeString(this.now()),
    });

    const partitionsChecked = partitions.filter((p) => p.partitionNo <= lastPartitionNo).length;
    const result = { year, done, partitionsChecked, partitionsTotal: partitions.length, findings };

    if (done) {
      const com7Count = await this.sourceRepository.countItec(year);
      result.summary = { com7Count, mappedTotal, larkGrandTotal, backfillIncomplete: mappedTotal < com7Count };
    }
    return result;
  }
}
