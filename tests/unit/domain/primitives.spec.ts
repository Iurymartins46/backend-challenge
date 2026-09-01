import { describe, expect, test } from 'bun:test';

import { RandomIdGenerator, SystemClock } from '../../../src/modules/wagering/domain';

describe('domain primitives', () => {
  test('SystemClock returns a Date', () => {
    expect(new SystemClock().now()).toBeInstanceOf(Date);
  });

  test('RandomIdGenerator creates non-empty unique identifiers', () => {
    const generator = new RandomIdGenerator();
    const first = generator.next();
    const second = generator.next();

    expect(first).not.toBe('');
    expect(second).not.toBe('');
    expect(first).not.toBe(second);
  });
});
