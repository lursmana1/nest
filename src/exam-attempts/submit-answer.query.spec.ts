import { describe, expect, it } from '@jest/globals';
import { SUBMIT_ANSWER_SQL } from './submit-answer.query';

describe('SUBMIT_ANSWER_SQL', () => {
  it('is a single statement with bind parameters', () => {
    expect(SUBMIT_ANSWER_SQL).toContain('$1::int');
    expect(SUBMIT_ANSWER_SQL).toContain('$4::text');
    expect(SUBMIT_ANSWER_SQL).not.toMatch(/\$\{/);
  });

  it('forces every data-modifying CTE to run', () => {
    const tail = SUBMIT_ANSWER_SQL.slice(
      SUBMIT_ANSWER_SQL.lastIndexOf('SELECT'),
    );
    expect(tail).toContain('LEFT JOIN settled');
    expect(tail).toContain('LEFT JOIN inserted');
    expect(tail).toContain('LEFT JOIN completed');
  });
});
