import { getRetryDelayMs } from './gemini.client';

describe('getRetryDelayMs', () => {
  it('uses the structured retryDelay Gemini returns', () => {
    expect(getRetryDelayMs({ errorDetails: [{ retryDelay: '27s' }] })).toBe(
      27_000,
    );
  });

  it('rounds fractional seconds up to whole milliseconds', () => {
    expect(getRetryDelayMs({ errorDetails: [{ retryDelay: '1.5s' }] })).toBe(
      1500,
    );
  });

  it('skips detail entries that carry no delay', () => {
    expect(getRetryDelayMs({ errorDetails: [{}, { retryDelay: '10s' }] })).toBe(
      10_000,
    );
  });

  it('never waits less than a second', () => {
    expect(getRetryDelayMs({ errorDetails: [{ retryDelay: '0.1s' }] })).toBe(
      1000,
    );
  });

  it('parses the delay out of the error message when unstructured', () => {
    expect(getRetryDelayMs(new Error('Quota exceeded, retry in 42s'))).toBe(
      42_000,
    );
  });

  it('falls back to 15s for an unrecognised error', () => {
    expect(getRetryDelayMs(new Error('boom'))).toBe(15_000);
    expect(getRetryDelayMs(undefined)).toBe(15_000);
  });
});
