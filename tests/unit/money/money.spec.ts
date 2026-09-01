import { describe, expect, test } from 'bun:test';

import {
  Money,
  MoneyCurrencyError,
  MoneyCurrencyMismatchError,
  MoneyFormatError,
  MoneyNegativeError,
  MoneyRangeError,
  MoneyScaleError,
} from '../../../src/modules/wagering/domain';

describe('Money', () => {
  test('parses and serializes canonical non-negative amounts exactly', () => {
    const cases = [
      ['0.00', 0n],
      ['0.01', 1n],
      ['25.00', 2500n],
      ['1000.99', 100099n],
      ['10000000000000000.09', 1000000000000000009n],
    ] as const;

    for (const [amount, minorUnits] of cases) {
      const money = Money.from({ amount, currency: 'BRL' });

      expect(money.toString()).toBe(amount);
      expect(money.toJSON()).toEqual({ amount, currency: 'BRL' });
      expect(money.toMinorUnits()).toBe(minorUnits);
    }
  });

  test('supports the exact positive BIGINT boundary', () => {
    const money = Money.from({ amount: '92233720368547758.07', currency: 'BRL' });

    expect(money.toMinorUnits()).toBe(9223372036854775807n);
    expect(money.toString()).toBe('92233720368547758.07');
  });

  test('rejects values above the BIGINT boundary', () => {
    expect(() => Money.from({ amount: '92233720368547758.08', currency: 'BRL' })).toThrow(
      MoneyRangeError,
    );
  });

  test('rejects negative external amounts but permits signed internal reconstruction', () => {
    expect(() => Money.from({ amount: '-1.00', currency: 'BRL' })).toThrow(MoneyNegativeError);

    const signed = Money.fromSigned({ amount: '-1.00', currency: 'BRL' });
    expect(signed.isNegative()).toBe(true);
    expect(signed.toJSON()).toEqual({ amount: '-1.00', currency: 'BRL' });
  });

  test('rejects invalid formats and scales without rounding', () => {
    const scaleCases = ['1', '1.0', '1.000', '1.005'];
    for (const amount of scaleCases) {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(MoneyScaleError);
    }

    const formatCases = ['', ' ', '.10', '01.00', '1,00', '1e2', 'NaN', 'Infinity'];
    for (const amount of formatCases) {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(MoneyFormatError);
    }
  });

  test('validates currencies and reports mismatches', () => {
    expect(() => Money.from({ amount: '1.00', currency: 'brl' })).toThrow(MoneyCurrencyError);
    expect(() => Money.from({ amount: '1.00', currency: 'BR' })).toThrow(MoneyCurrencyError);

    const brl = Money.from({ amount: '1.00', currency: 'BRL' });
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    expect(() => brl.add(usd)).toThrow(MoneyCurrencyMismatchError);
    expect(() => brl.equals(usd)).toThrow(MoneyCurrencyMismatchError);
  });

  test('keeps operations immutable and exact', () => {
    const original = Money.from({ amount: '25.00', currency: 'BRL' });
    const addition = original.add(Money.from({ amount: '0.01', currency: 'BRL' }));
    const subtraction = addition.subtract(Money.from({ amount: '25.00', currency: 'BRL' }));

    expect(original.toString()).toBe('25.00');
    expect(addition.toString()).toBe('25.01');
    expect(subtraction.toString()).toBe('0.01');
    expect(addition.negate().toString()).toBe('-25.01');
    expect(addition.add(addition.negate()).isZero()).toBe(true);
  });

  test('supports zero, comparisons and signed underflow checks', () => {
    const zero = Money.zero('BRL');
    const one = Money.from({ amount: '0.01', currency: 'BRL' });

    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);
    expect(zero.isLessThan(one)).toBe(true);
    expect(one.isPositive()).toBe(true);
    expect(one.equals(Money.fromMinorUnits(1n, 'BRL'))).toBe(true);
    expect(() => Money.fromMinorUnits(-9223372036854775808n, 'BRL').negate()).toThrow(
      MoneyRangeError,
    );
  });

  test('serializes through Money.toJSON without leaking bigint', () => {
    const money = Money.from({ amount: '25.00', currency: 'BRL' });

    expect(JSON.stringify(money)).toBe('{"amount":"25.00","currency":"BRL"}');
    expect(JSON.stringify({ money })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
  });
});
