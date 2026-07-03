/**
 * Provision a year base: ensure partition tables itec_001..itec_N exist, each
 * with the full field schema. Lark is the source of truth (Approach A): we diff
 * desired vs existing tables and create only the missing ones, within a soft
 * time budget so the sync HTTP request never runs past a proxy timeout.
 * Idempotent + resumable — re-invoking continues where it stopped.
 *
 * `createTable` creates the table with all its fields atomically (verified —
 * see lark-base-v3-api-notes.md), so "table exists" ⇒ "partition complete".
 * We deliberately do NOT enumerate fields: the base/v3 list-fields endpoint
 * caps at 20 items with no pagination, so it can't confirm a 41-field table.
 *
 * After the Lark work, every present partition (both newly created and
 * pre-existing) is written through to `yearRepository` (sync_year /
 * sync_partition) in one batch. This makes the MySQL cache self-healing:
 * a base provisioned before write-through existed gets backfilled on its
 * next /base/init call.
 */
export class ProvisionYearBase {
  constructor({ fieldSchema, partitionCount, partitionName, parsePartitionNo, yearRepository, now = Date.now }) {
    this.fieldSchema = fieldSchema;
    this.partitionCount = partitionCount;
    this.partitionName = partitionName;
    this.parsePartitionNo = parsePartitionNo;
    this.yearRepository = yearRepository;
    this.now = now;
  }

  async execute({ gateway, base, year, budgetMs }) {
    await gateway.getBase(base); // throws BaseNotFoundError -> controller maps 404

    const tables = await gateway.listTables(base);
    const byNo = new Map(); // partitionNo -> tableId, for both existing and newly created
    for (const t of tables) {
      const no = this.parsePartitionNo(t.name);
      if (no != null) byNo.set(no, t.tableId);
    }

    const start = this.now();
    const budgetLeft = () => this.now() - start < budgetMs;

    let existing = 0;
    let created = 0;
    let remaining = 0;
    let stopped = false;

    for (let n = 1; n <= this.partitionCount; n++) {
      if (byNo.has(n)) { existing++; continue; }
      if (stopped || !budgetLeft()) { stopped = true; remaining++; continue; }
      const tableId = await gateway.createTable(base, this.partitionName(n), this.fieldSchema);
      byNo.set(n, tableId);
      created++;
    }

    const done = remaining === 0;
    // Only write through partitions in this call's configured range. `byNo`
    // may also hold stray itec_NNN tables outside 1..partitionCount (e.g.
    // leftovers from a differently-scoped run against the same base) — those
    // are not this call's concern and must not be recorded under this year.
    const inRange = [...byNo].filter(([no]) => no >= 1 && no <= this.partitionCount);
    await this.yearRepository.upsertPartitions(
      year,
      inRange.map(([partitionNo, larkTableId]) => ({ partitionNo, larkTableId })),
    );
    await this.yearRepository.upsertYear({ year, baseId: base, status: done ? 'complete' : 'partial' });

    return { year, base, total: this.partitionCount, existing, created, remaining, done };
  }
}
