import { validateEnv } from './env.validation';

const prod = (extra: Record<string, unknown> = {}) => ({
  NODE_ENV: 'production',
  JWT_SECRET: 'secret',
  DATABASE_URL: 'postgres://localhost/db',
  FRONTEND_ORIGIN: 'https://prava.ge',
  ...extra,
});

describe('validateEnv', () => {
  it('accepts a complete production config', () => {
    expect(() => validateEnv(prod())).not.toThrow();
  });

  it('rejects a missing JWT_SECRET in any environment', () => {
    expect(() => validateEnv({ NODE_ENV: 'development' })).toThrow(
      /JWT_SECRET is required/,
    );
  });

  it('treats a whitespace-only secret as missing', () => {
    expect(() => validateEnv({ JWT_SECRET: '   ' })).toThrow(
      /JWT_SECRET is required/,
    );
  });

  it('allows a local run without DATABASE_URL or FRONTEND_ORIGIN', () => {
    expect(() =>
      validateEnv({ NODE_ENV: 'development', JWT_SECRET: 'secret' }),
    ).not.toThrow();
  });

  it.each(['DATABASE_URL', 'FRONTEND_ORIGIN'])(
    'requires %s in production',
    (key) => {
      expect(() => validateEnv(prod({ [key]: undefined }))).toThrow(
        new RegExp(`${key} is required when NODE_ENV=production`),
      );
    },
  );

  it('refuses to boot production with schema sync enabled', () => {
    expect(() => validateEnv(prod({ DB_SYNCHRONIZE: 'true' }))).toThrow(
      /DB_SYNCHRONIZE must not be "true" in production/,
    );
  });

  it('permits schema sync outside production', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'development',
        JWT_SECRET: 'secret',
        DB_SYNCHRONIZE: 'true',
      }),
    ).not.toThrow();
  });

  it('reports every problem at once rather than one per restart', () => {
    expect(() =>
      validateEnv({ NODE_ENV: 'production', DB_SYNCHRONIZE: 'true' }),
    ).toThrow(/JWT_SECRET[\s\S]*DATABASE_URL[\s\S]*FRONTEND_ORIGIN/);
  });

  it('returns the config unchanged when valid', () => {
    const config = prod();
    expect(validateEnv(config)).toBe(config);
  });
});
