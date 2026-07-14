/**
 * One LarkBase table (itec_001..itec_270) inside a year's base, plus the
 * current fill count used for atomic slot reservation during backfill (§10).
 */
export class Partition {
  /** @param {{ year:number, partitionNo:number, larkTableId?:string|null, fillCount?:number }} props */
  constructor({ year, partitionNo, larkTableId = null, fillCount = 0 }) {
    this.year = year;
    this.partitionNo = partitionNo;
    this.larkTableId = larkTableId;
    this.fillCount = fillCount;
  }

  get remaining() {
    return Partition.CAPACITY - this.fillCount;
  }

  get isFull() {
    return this.fillCount >= Partition.CAPACITY;
  }
}

/** Records per Lark table before rolling to the next partition (§3). */
Partition.CAPACITY = 20000;
