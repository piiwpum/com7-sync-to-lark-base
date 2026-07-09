/**
 * Remove all partition tables (itec_NNN) from a year base. Lark is the
 * source of truth: lists tables, deletes every one whose name matches the
 * itec partition pattern, and leaves every other table (e.g. daily tables,
 * ad-hoc tables) untouched. For each partition dropped on Lark, the ops side
 * is cleaned too — its sync_partition row AND its sync_mapping rows — so no
 * orphan mappings point at now-deleted records. Unlike hard-full-sync this
 * does NOT re-sync afterwards; it only removes. Runs within a soft time budget
 * so the HTTP request never runs past a proxy timeout; idempotent + resumable —
 * re-invoking continues deleting whatever partitions remain, and the ops
 * cleanup targets only the partitions actually dropped in that run.
 *
 * `dryRun: true` reports what would be deleted (table names) without
 * deleting anything, on Lark or in MySQL.
 */
export class RemoveAllPartitions {
  constructor({ parsePartitionNo, yearRepository, mappingRepository, now = Date.now }) {
    this.parsePartitionNo = parsePartitionNo;
    this.yearRepository = yearRepository;
    this.mappingRepository = mappingRepository;
    this.now = now;
  }

  async execute({ gateway, base, year, budgetMs, dryRun = false }) {
    await gateway.getBase(base); // throws BaseNotFoundError -> controller maps 404

    const tables = await gateway.listTables(base);
    const partitions = tables.filter((t) => this.parsePartitionNo(t.name) != null);

    if (dryRun) {
      return {
        year, base, total: partitions.length, deleted: 0, remaining: partitions.length,
        done: partitions.length === 0, dryRun: true, tables: partitions.map((t) => t.name),
      };
    }

    const start = this.now();
    const budgetLeft = () => this.now() - start < budgetMs;

    let deleted = 0;
    let remaining = 0;
    let stopped = false;
    const deletedNos = [];

    for (const t of partitions) {
      if (stopped || !budgetLeft()) { stopped = true; remaining++; continue; }
      await gateway.deleteTable(base, t.tableId);
      deletedNos.push(this.parsePartitionNo(t.name));
      deleted++;
    }

    // Clean the ops side for the partitions we actually dropped: mapping rows
    // first (the records they point at are gone), then the sync_partition rows.
    await this.mappingRepository.deleteMappingsForPartitions({ year, partitionNos: deletedNos });
    await this.yearRepository.deletePartitions(year, deletedNos);

    return { year, base, total: partitions.length, deleted, remaining, done: remaining === 0 };
  }
}
