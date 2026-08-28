export type PageParams = { page: number; size: number };

export type PageQuery = {
  page?: number;
  /** Canonical page-size param. */
  size?: number;
  /** Accepted alias for `size`, kept for clients that send `limit`. */
  limit?: number;
};

export type PageBounds = { defaultSize: number; maxSize: number };

const toPositiveInt = (value: number | undefined): number | undefined => {
  if (value == null) return undefined;
  const truncated = Math.trunc(value);
  return Number.isFinite(truncated) && truncated > 0 ? truncated : undefined;
};

/**
 * Clamps user-supplied paging into a safe range so a large or malformed
 * `size` can never turn a list endpoint into a full-table scan.
 */
export function resolvePageParams(
  query: PageQuery,
  { defaultSize, maxSize }: PageBounds,
): PageParams {
  const requested = toPositiveInt(query.size) ?? toPositiveInt(query.limit);
  return {
    page: toPositiveInt(query.page) ?? 1,
    size: Math.min(requested ?? defaultSize, maxSize),
  };
}
