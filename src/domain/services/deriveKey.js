/** Identity key (§6.1): immutable, verified unique on 10M real Com7 rows. */
export function deriveKey(row) {
  return `${row.SellBranch}|${row.SellID}|${row.RowNo}`;
}
