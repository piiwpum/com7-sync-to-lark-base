/**
 * The durable link between a Com7 source row and its Lark record (§6).
 *   sourceKey = deriveKey(row)      — identity (immutable)
 *   checksum  = crc32(row)          — drift detection (source changed?)
 * baseId/larkTableId are denormalized here (migration 007) so the
 * incremental sync path never has to JOIN sync_year/sync_partition.
 * Lives in MySQL instance B; never rebuilt by fetching from Lark (§3).
 */
export class Mapping {
  /** @param {{ year:number, baseId:string, sourceKey:string, partitionNo:number, larkTableId:string, larkRecordId:string, checksum:number, crTime:Date, uTime:Date }} props */
  constructor({ year, baseId, sourceKey, partitionNo, larkTableId, larkRecordId, checksum, crTime, uTime }) {
    this.year = year;
    this.baseId = baseId;
    this.sourceKey = sourceKey;
    this.partitionNo = partitionNo;
    this.larkTableId = larkTableId;
    this.larkRecordId = larkRecordId;
    this.checksum = checksum;
    this.crTime = crTime;
    this.uTime = uTime;
  }
}
