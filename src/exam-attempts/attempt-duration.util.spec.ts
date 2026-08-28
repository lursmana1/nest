import {
  attemptDeadline,
  computeAttemptDuration,
  isAttemptExpired,
  resolveDisplayDuration,
} from './attempt-duration.util';
import type { ExamAttempt } from './entities/exam-attempt.entity';

function attempt(partial: Partial<ExamAttempt>): ExamAttempt {
  return partial as ExamAttempt;
}

describe('computeAttemptDuration', () => {
  it('returns whole seconds between start and completion', () => {
    const createdAt = new Date('2026-01-01T10:00:00Z');
    const completedAt = new Date('2026-01-01T10:12:30Z');
    expect(computeAttemptDuration(attempt({ createdAt }), completedAt)).toBe(
      750,
    );
  });

  it('returns 0 when createdAt is missing', () => {
    expect(
      computeAttemptDuration(
        attempt({ createdAt: undefined }),
        new Date('2026-01-01T10:00:00Z'),
      ),
    ).toBe(0);
  });

  it('clamps anything longer than the exam window', () => {
    const createdAt = new Date('2026-01-01T10:00:00Z');
    const completedAt = new Date('2026-01-02T10:00:00Z');
    expect(computeAttemptDuration(attempt({ createdAt }), completedAt)).toBe(
      30 * 60,
    );
  });
});

describe('resolveDisplayDuration', () => {
  it('is null while the attempt is still open', () => {
    expect(
      resolveDisplayDuration(
        attempt({ createdAt: new Date(), completedAt: null }),
      ),
    ).toBeNull();
  });
});

describe('attemptDeadline', () => {
  it('parses a string endDate coming back from the driver', () => {
    const deadline = attemptDeadline(
      attempt({ endDate: '2026-01-01T10:30:00Z' as unknown as Date }),
    );
    expect(deadline?.toISOString()).toBe('2026-01-01T10:30:00.000Z');
  });

  it('is null when endDate was never set', () => {
    expect(attemptDeadline(attempt({ endDate: null }))).toBeNull();
  });
});

describe('isAttemptExpired', () => {
  const endDate = new Date('2026-01-01T10:30:00Z');

  it('is false one second before the deadline', () => {
    expect(
      isAttemptExpired(attempt({ endDate }), new Date('2026-01-01T10:29:59Z')),
    ).toBe(false);
  });

  it('is false exactly at the deadline', () => {
    expect(isAttemptExpired(attempt({ endDate }), endDate)).toBe(false);
  });

  it('is true one second after the deadline', () => {
    expect(
      isAttemptExpired(attempt({ endDate }), new Date('2026-01-01T10:30:01Z')),
    ).toBe(true);
  });

  it('never expires when no deadline was stored', () => {
    expect(isAttemptExpired(attempt({ endDate: null }), new Date())).toBe(
      false,
    );
  });
});
