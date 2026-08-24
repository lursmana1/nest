/** Display metadata for license categories (IDs match DB, frontend `?category=`, exam rules). */
export type CategoryDisplayMeta = {
  id: number;
  name: string;
  iconKey: string;
};

export const CATEGORY_DISPLAY_META: CategoryDisplayMeta[] = [
  { id: 0, name: 'AM', iconKey: 'am' },
  { id: 1, name: 'B', iconKey: 'b' },
  { id: 2, name: 'A', iconKey: 'a' },
  { id: 3, name: 'C', iconKey: 'c' },
  { id: 4, name: 'D', iconKey: 'd' },
  { id: 5, name: 'C1', iconKey: 'c1' },
  { id: 6, name: 'D1', iconKey: 'd1' },
  { id: 7, name: 'Military', iconKey: 'military' },
  { id: 8, name: 'Tram', iconKey: 'tram' },
  { id: 9, name: 'T/S', iconKey: 'ts' },
];

const CATEGORY_BY_ID = new Map(CATEGORY_DISPLAY_META.map((c) => [c.id, c]));

export function getCategoryDisplayMeta(
  categoryId: number,
): CategoryDisplayMeta | undefined {
  return CATEGORY_BY_ID.get(categoryId);
}

export function isValidCategoryId(categoryId: number): boolean {
  return CATEGORY_BY_ID.has(categoryId);
}
