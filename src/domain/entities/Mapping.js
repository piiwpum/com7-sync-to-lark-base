/**
 * The durable link between a Com7 source row and its Lark record (§6).
 *   sourceKey = deriveKey(row)      — identity (immutable)
 *   checksum  = crc32(row)          — drift detection (source changed?)
 * Lives in MySQL instance B; never rebuilt by fetching from Lark (§3).
 */
export class Mapping {
  /** @param {{ year:number, sourceKey:string, partitionNo:number, larkRecordId:string, checksum:number, crTime:Date, uTime:Date }} props */
  constructor({ year, sourceKey, partitionNo, larkRecordId, checksum, crTime, uTime }) {
    this.year = year;
    this.sourceKey = sourceKey;
    this.partitionNo = partitionNo;
    this.larkRecordId = larkRecordId;
    this.checksum = checksum;
    this.crTime = crTime;
    this.uTime = uTime;
  }
}
