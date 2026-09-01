import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ErrorItemDto {
  @ApiProperty({ example: 'error.request.invalid_json' })
  code!: string;

  @ApiProperty({ example: 'The request body is invalid.' })
  detail!: string;

  @ApiPropertyOptional({ example: 'money.amount' })
  field?: string;
}

export class ErrorResponseDto {
  @ApiProperty({ example: 422 })
  status!: number;

  @ApiProperty({ example: 'Transaction rejected' })
  title!: string;

  @ApiProperty({ example: 'The transaction could not be processed.' })
  detail!: string;

  @ApiProperty({ example: '4bf92f3577b34da6a3ce929d0e0e4736' })
  traceId!: string;

  @ApiProperty({ type: () => [ErrorItemDto], minItems: 1 })
  errors!: ErrorItemDto[];
}
