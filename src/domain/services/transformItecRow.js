import { ITEC_FIELD_SCHEMA } from '../../infrastructure/config/itecFieldSchema.js';
import { beDateStringToEpochMs } from './dateConversion.js';

/**
 * Raw Com7 `itec` row (keys = exact DB column names, including spaced ones
 * like "MIN PRICE") -> Lark field-value object, in ITEC_FIELD_SCHEMA order
 * (order matters: checksum is computed over this same deterministic shape).
 */
export function transformItecRow(row) {
  const out = {};
  for (const field of ITEC_FIELD_SCHEMA) {
    const raw = row[field.name];
    if (raw == null) {
      out[field.name] = null;
    } else if (field.type === 'datetime') {
      out[field.name] = beDateStringToEpochMs(raw);
    } else if (field.type === 'number') {
      out[field.name] = Number(raw);
    } else {
      out[field.name] = String(raw);
    }
  }
  return out;
}
