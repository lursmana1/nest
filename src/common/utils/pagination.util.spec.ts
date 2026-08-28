import { resolvePageParams } from './pagination.util';

const BOUNDS = { defaultSize: 10, maxSize: 50 };

describe('resolvePageParams', () => {
  it('applies defaults for an empty query', () => {
    expect(resolvePageParams({}, BOUNDS)).toEqual({ page: 1, size: 10 });
  });

  it('passes valid values through', () => {
    expect(resolvePageParams({ page: 3, size: 25 }, BOUNDS)).toEqual({
      page: 3,
      size: 25,
    });
  });

  it('accepts limit as an alias for size', () => {
    expect(resolvePageParams({ limit: 25 }, BOUNDS).size).toBe(25);
  });

  it('prefers size when a client sends both', () => {
    expect(resolvePageParams({ size: 5, limit: 40 }, BOUNDS).size).toBe(5);
  });

  it('caps size at the maximum', () => {
    expect(resolvePageParams({ size: 5000 }, BOUNDS).size).toBe(50);
  });

  it.each([0, -1, -100])('falls back to page 1 for page=%p', (page) => {
    expect(resolvePageParams({ page }, BOUNDS).page).toBe(1);
  });

  it.each([0, -5])('falls back to the default size for size=%p', (size) => {
    expect(resolvePageParams({ size }, BOUNDS).size).toBe(10);
  });

  it('ignores non-finite input', () => {
    expect(resolvePageParams({ page: NaN, size: NaN }, BOUNDS)).toEqual({
      page: 1,
      size: 10,
    });
  });

  it('truncates fractional values rather than rejecting them', () => {
    expect(resolvePageParams({ page: 2.9, size: 12.7 }, BOUNDS)).toEqual({
      page: 2,
      size: 12,
    });
  });

  it('falls through to limit when size is invalid', () => {
    expect(resolvePageParams({ size: 0, limit: 30 }, BOUNDS).size).toBe(30);
  });
});
