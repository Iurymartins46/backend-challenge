import {
  MoneyCurrencyError,
  MoneyCurrencyMismatchError,
  MoneyFormatError,
  MoneyNegativeError,
  MoneyRangeError,
  MoneyScaleError,
} from './errors';

export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

export interface MoneyMinorUnitsProps {
  readonly minorUnits: bigint;
  readonly currency: string;
}

const MIN_BIGINT = -(1n << 63n);
const MAX_BIGINT = (1n << 63n) - 1n;
const MINOR_UNITS_PER_MAJOR = 100n;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const ISO_4217_CURRENCIES = new Set(Intl.supportedValuesOf('currency'));
const CANONICAL_UNSIGNED_AMOUNT_PATTERN = /^(0|[1-9][0-9]*)\.[0-9]{2}$/;
const DECIMAL_AMOUNT_PATTERN = /^(?:[0-9]+)(?:\.[0-9]*)?$/;

function assertCurrency(currency: unknown): asserts currency is string {
  if (
    typeof currency !== 'string' ||
    !CURRENCY_PATTERN.test(currency) ||
    !ISO_4217_CURRENCIES.has(currency)
  ) {
    throw new MoneyCurrencyError(currency);
  }
}

function assertWithinBigIntRange(minorUnits: bigint): void {
  if (minorUnits < MIN_BIGINT || minorUnits > MAX_BIGINT) {
    throw new MoneyRangeError();
  }
}

function classifyAmountFormat(amount: string): never {
  const wholePart = amount.split('.')[0];
  if (wholePart !== undefined && wholePart.length > 1 && wholePart.startsWith('0')) {
    throw new MoneyFormatError(amount);
  }

  if (DECIMAL_AMOUNT_PATTERN.test(amount) && amount.includes('.')) {
    throw new MoneyScaleError(amount);
  }

  if (DECIMAL_AMOUNT_PATTERN.test(amount) && !amount.includes('.')) {
    throw new MoneyScaleError(amount);
  }

  throw new MoneyFormatError(amount);
}

function parseAmount(amount: unknown, allowNegative: boolean): bigint {
  if (typeof amount !== 'string' || amount.length === 0 || amount.trim() !== amount) {
    throw new MoneyFormatError(amount);
  }

  const negative = amount.startsWith('-');
  const unsignedAmount = negative ? amount.slice(1) : amount;

  if (negative && !allowNegative) {
    throw new MoneyNegativeError(amount);
  }

  if (!CANONICAL_UNSIGNED_AMOUNT_PATTERN.test(unsignedAmount)) {
    classifyAmountFormat(unsignedAmount);
  }

  const [whole, fractional] = unsignedAmount.split('.');
  const minorUnits = BigInt(`${whole}${fractional}`);
  const signedMinorUnits = negative ? -minorUnits : minorUnits;
  assertWithinBigIntRange(signedMinorUnits);
  return signedMinorUnits;
}

function formatAmount(minorUnits: bigint): string {
  const negative = minorUnits < 0n;
  const absoluteMinorUnits = negative ? -minorUnits : minorUnits;
  const whole = absoluteMinorUnits / MINOR_UNITS_PER_MAJOR;
  const fractional = (absoluteMinorUnits % MINOR_UNITS_PER_MAJOR).toString().padStart(2, '0');

  return `${negative ? '-' : ''}${whole.toString()}.${fractional}`;
}

export class Money {
  private constructor(
    private readonly valueInMinorUnits: bigint,
    public readonly currency: string,
  ) {}

  /** Creates money received from an external contract; negative amounts are forbidden. */
  static from(props: MoneyProps): Money {
    assertCurrency(props.currency);
    const minorUnits = parseAmount(props.amount, false);
    return new Money(minorUnits, props.currency);
  }

  /** Reconstructs signed money from a canonical decimal string for internal calculations. */
  static fromSigned(props: MoneyProps): Money {
    assertCurrency(props.currency);
    const minorUnits = parseAmount(props.amount, true);
    return new Money(minorUnits, props.currency);
  }

  /** Reconstructs persisted or calculated money without passing through floating point. */
  static rehydrate(props: MoneyMinorUnitsProps): Money {
    assertCurrency(props.currency);
    if (typeof props.minorUnits !== 'bigint') {
      throw new MoneyRangeError();
    }

    assertWithinBigIntRange(props.minorUnits);
    return new Money(props.minorUnits, props.currency);
  }

  static fromMinorUnits(minorUnits: bigint, currency: string): Money {
    return Money.rehydrate({ minorUnits, currency });
  }

  static zero(currency: string): Money {
    return Money.rehydrate({ minorUnits: 0n, currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.rehydrate({
      minorUnits: this.valueInMinorUnits + other.valueInMinorUnits,
      currency: this.currency,
    });
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.rehydrate({
      minorUnits: this.valueInMinorUnits - other.valueInMinorUnits,
      currency: this.currency,
    });
  }

  negate(): Money {
    return Money.rehydrate({
      minorUnits: -this.valueInMinorUnits,
      currency: this.currency,
    });
  }

  isZero(): boolean {
    return this.valueInMinorUnits === 0n;
  }

  isPositive(): boolean {
    return this.valueInMinorUnits > 0n;
  }

  isNegative(): boolean {
    return this.valueInMinorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.valueInMinorUnits < other.valueInMinorUnits;
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.valueInMinorUnits === other.valueInMinorUnits;
  }

  toMinorUnits(): bigint {
    return this.valueInMinorUnits;
  }

  toJSON(): MoneyProps {
    return {
      amount: formatAmount(this.valueInMinorUnits),
      currency: this.currency,
    };
  }

  toString(): string {
    return formatAmount(this.valueInMinorUnits);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new MoneyCurrencyMismatchError(this.currency, other.currency);
    }
  }
}
