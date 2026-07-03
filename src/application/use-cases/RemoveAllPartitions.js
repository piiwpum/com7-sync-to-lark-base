/**
 * Remove all partition tables (itec_NNN) from a year base. Lark is the
 * source of truth: lists tables, deletes every one whose name matches the
 * itec partition pattern, and leaves every other table (e.g. daily tables,
 * ad-hoc tables) untouched. Runs within a soft time budget so the HTTP
 * request never runs past a proxy timeout; idempotent + resumable —
 * re-invoking continues deleting whatever partitions remain.
 */
export class RemoveAllPartitions {
  constructor({ parsePartitionNo, now = Date.now }) {
    this.parsePartitionNo = parsePartitionNo;
    this.now = now;
  }

  async execute({ gateway, base, year, budgetMs }) {
    await gateway.getBase(base); // throws BaseNotFoundError -> controller maps 404

    const tables = await gateway.listTables(base);
    const partitions = tables.filter((t) => this.parsePartitionNo(t.name) != null);

    const start = this.now();
    const budgetLeft = () => this.now() - start < budgetMs;

    let deleted = 0;
    let remaining = 0;
    let stopped = false;

    for (const t of partitions) {
      if (stopped || !budgetLeft()) { stopped = true; remaining++; continue; }
      await gateway.deleteTable(base, t.tableId);
      deleted++;
    }

    return { year, base, total: partitions.length, deleted, remaining, done: remaining === 0 };
  }
}
