/**
 * Raw Postgres rows deliver booleans inconsistently: the driver returns real
 * booleans for entity reads but `'t'`/`'f'` strings for some raw/aggregate
 * queries. Anything not recognisably true is treated as false.
 */
export function parsePgBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 't' || normalized === 'true' || normalized === '1';
  }
  return false;
}

/** `COUNT(*)`/`SUM(...)` arrive as strings; NULL means "no rows matched". */
export function parsePgInt(value: unknown, fallback = 0): number {
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
