/**
 * Parse comma-separated string into array of numbers.
 * e.g. "1,2,3" -> [1, 2, 3]
 */
export function parseIdList(value: string | undefined): number[] | undefined {
  if (!value?.trim()) return undefined;
  return value
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter(Number.isFinite);
}

/**
 * Parse string to number. Returns undefined if invalid.
 */
export function parseCount(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse unknown (from body/query) to number. Returns null if invalid.
 * Caller should throw BadRequestException when null.
 */
export function parseNumericId(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}
