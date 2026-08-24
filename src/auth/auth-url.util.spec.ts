import {
  assertGoogleOAuthConfig,
  resolveGoogleCallbackUrl,
  resolveGoogleLoginUrl,
} from './auth-url.util';

describe('auth-url.util', () => {
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env };
    delete process.env.API_PUBLIC_URL;
    delete process.env.GOOGLE_CALLBACK_URL;
  });

  afterAll(() => {
    process.env = env;
  });

  it('builds callback from API_PUBLIC_URL', () => {
    process.env.API_PUBLIC_URL = 'https://api.prava.ucos.ge';
    expect(resolveGoogleCallbackUrl()).toBe(
      'https://api.prava.ucos.ge/auth/google/callback',
    );
    expect(resolveGoogleLoginUrl()).toBe(
      'https://api.prava.ucos.ge/auth/google',
    );
  });

  it('prefers explicit GOOGLE_CALLBACK_URL', () => {
    process.env.GOOGLE_CALLBACK_URL =
      'https://api.prava.ucos.ge/auth/google/callback';
    expect(resolveGoogleCallbackUrl()).toBe(
      'https://api.prava.ucos.ge/auth/google/callback',
    );
  });

  it('strips accidental newlines from callback URL', () => {
    process.env.GOOGLE_CALLBACK_URL =
      'https://nest-bw53.onrender.com/auth/google/callback\n';
    expect(resolveGoogleCallbackUrl()).toBe(
      'https://nest-bw53.onrender.com/auth/google/callback',
    );
  });

  it('rejects http callback outside localhost in production checks', () => {
    process.env.GOOGLE_CLIENT_ID = 'id';
    process.env.GOOGLE_CLIENT_SECRET = 'secret';
    process.env.GOOGLE_CALLBACK_URL =
      'http://api.prava.ucos.ge/auth/google/callback';

    const warnings = assertGoogleOAuthConfig();
    expect(warnings.some((w) => w.includes('HTTPS'))).toBe(true);
  });
});
