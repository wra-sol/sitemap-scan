import { describe, expect, it } from 'vitest';
import { matchesCronExpression } from './cron';

describe('matchesCronExpression', () => {
  it('matches exact daily schedules in UTC', () => {
    const runAt = new Date('2026-03-05T02:00:00.000Z');

    expect(matchesCronExpression('0 2 * * *', runAt)).toBe(true);
    expect(matchesCronExpression('5 2 * * *', runAt)).toBe(false);
  });

  it('matches step-based schedules', () => {
    const runAt = new Date('2026-03-05T02:15:00.000Z');

    expect(matchesCronExpression('*/5 * * * *', runAt)).toBe(true);
    expect(matchesCronExpression('*/20 * * * *', runAt)).toBe(false);
  });

  it('returns false for invalid expressions', () => {
    expect(matchesCronExpression('not-a-cron', new Date('2026-03-05T02:00:00.000Z'))).toBe(false);
  });
});
