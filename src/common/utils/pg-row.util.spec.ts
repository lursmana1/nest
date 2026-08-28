import { parsePgBoolean, parsePgInt } from './pg-row.util';

describe('parsePgBoolean', () => {
  it.each([true, 't', 'true', 'TRUE', ' t ', 1, '1'])(
    'reads %p as true',
    (value) => {
      expect(parsePgBoolean(value)).toBe(true);
    },
  );

  it.each([false, 'f', 'false', 'FALSE', 0, '0', '', null, undefined])(
    'reads %p as false',
    (value) => {
      expect(parsePgBoolean(value)).toBe(false);
    },
  );

  it('does not treat an arbitrary string as true', () => {
    expect(parsePgBoolean('yes please')).toBe(false);
  });
});

describe('parsePgInt', () => {
  it('parses the strings that COUNT and SUM return', () => {
    expect(parsePgInt('42')).toBe(42);
  });

  it('passes real numbers through', () => {
    expect(parsePgInt(7)).toBe(7);
  });

  it('falls back when the aggregate matched no rows', () => {
    expect(parsePgInt(null)).toBe(0);
    expect(parsePgInt(undefined, 5)).toBe(5);
  });

  it('falls back rather than propagating NaN', () => {
    expect(parsePgInt('not a number', -1)).toBe(-1);
  });
});
