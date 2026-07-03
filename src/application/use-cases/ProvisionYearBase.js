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
 */
export class ProvisionYearBase {
  constructor({ fieldSchema, partitionCount, partitionName, parsePartitionNo, now = Date.now }) {
    this.fieldSchema = fieldSchema;
    this.partitionCount = partitionCount;
    this.partitionName = partitionName;
    this.parsePartitionNo = parsePartitionNo;
    this.now = now;
  }

  async execute({ gateway, base, year, budgetMs }) {
    await gateway.getBase(base); // throws BaseNotFoundError -> controller maps 404

    const tables = await gateway.listTables(base);
    const present = new Set();
    for (const t of tables) {
      const no = this.parsePartitionNo(t.name);
      if (no != null) present.add(no);
    }

    const start = this.now();
    const budgetLeft = () => this.now() - start < budgetMs;

    let existing = 0;
    let created = 0;
    let remaining = 0;
    let stopped = false;

    for (let n = 1; n <= this.partitionCount; n++) {
      if (present.has(n)) { existing++; continue; }
      if (stopped || !budgetLeft()) { stopped = true; remaining++; continue; }
      await gateway.createTable(base, this.partitionName(n), this.fieldSchema);
      created++;
    }

    return { year, base, total: this.partitionCount, existing, created, remaining, done: remaining === 0 };
  }
}
