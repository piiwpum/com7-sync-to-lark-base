/**
 * A sync year → one LarkBase base (Decision #3). Config-driven (Decision #8):
 * adding a year is just a new row, no code change.
 */
export class SyncYear {
  /** @param {{ year:number, baseId:string, status?:string }} props */
  constructor({ year, baseId, status = 'pending' }) {
    this.year = year;
    this.baseId = baseId;
    this.status = status;
  }
}
