import { ApiProperty } from '@nestjs/swagger';

export class MoneyDto {
  @ApiProperty({
    example: '25.00',
    pattern: '^(0|[1-9][0-9]*)\\.[0-9]{2}$',
    description: 'Decimal string with exactly two fractional digits.',
  })
  amount!: string;

  @ApiProperty({ example: 'BRL', minLength: 3, maxLength: 3 })
  currency!: string;
}
