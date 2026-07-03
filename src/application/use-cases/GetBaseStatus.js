import { YearNotProvisionedError } from '../../domain/errors.js';

/**
 * Read-only provisioning status for a year, answered entirely from MySQL
 * (sync_year / sync_partition) — no Lark round-trip, unlike
 * ProvisionYearBase/RemoveAllPartitions which must talk to Lark.
 */
export class GetBaseStatus {
  constructor({ partitionCount, yearRepository }) {
    this.partitionCount = partitionCount;
    this.yearRepository = yearRepository;
  }

  async execute({ year }) {
    const yearRow = await this.yearRepository.getYear(year);
    if (!yearRow) throw new YearNotProvisionedError(year);

    const partitions = await this.yearRepository.listPartitions(year);
    const existing = partitions.length;
    const missing = this.partitionCount - existing;

    return {
      year, base: yearRow.baseId, status: yearRow.status,
      total: this.partitionCount, existing, missing, complete: missing === 0,
    };
  }
}
