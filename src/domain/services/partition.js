export const PARTITION_COUNT = 250;

export function partitionName(n) {
  return `itec_${String(n).padStart(3, '0')}`;
}

const RE = /^itec_(\d{3})$/;

export function parsePartitionNo(name) {
  const m = RE.exec(name);
  if (!m) return null;
  return Number(m[1]);
}
