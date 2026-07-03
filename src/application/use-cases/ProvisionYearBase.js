/**
 * Provision a year base: ensure partition tables itec_001..itec_N exist, each
 * with the full field schema. Lark is the source of truth (Approach A):
 * we diff desired vs existing and create only what is missing, within a soft
 * time budget so the sync HTTP request never runs past a proxy timeout. It is
 * idempotent + resumable — re-invoking continues where it stopped.
 */
export class ProvisionYearBase {
  constructor({ fieldSchema, fieldNames, partitionCount, partitionName, parsePartitionNo, now = Date.now }) {
    this.fieldSchema = fieldSchema;
    this.fieldNames = fieldNames;
    this.partitionCount = partitionCount;
    this.partitionName = partitionName;
    this.parsePartitionNo = parsePartitionNo;
    this.now = now;
  }

  async execute({ gateway, base, year, budgetMs }) {
    await gateway.getBase(base); // throws BaseNotFoundError -> controller maps 404

    const tables = await gateway.listTables(base);
    const byNo = new Map();
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
      const tableId = byNo.get(n);

      if (tableId) {
        existing++;
        const have = new Set(await gateway.listFields(base, tableId));
        const missing = this.fieldSchema.filter((f) => !have.has(f.name));
        if (missing.length === 0) continue; // partition already complete
        if (stopped || !budgetLeft()) { stopped = true; remaining++; continue; }
        for (const f of missing) await gateway.createField(base, tableId, f);
      } else {
        if (stopped || !budgetLeft()) { stopped = true; remaining++; continue; }
        await gateway.createTable(base, this.partitionName(n), this.fieldSchema);
        created++;
      }
    }

    return { year, base, total: this.partitionCount, existing, created, remaining, done: remaining === 0 };
  }
}
