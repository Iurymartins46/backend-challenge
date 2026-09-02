import { ApiProperty } from '@nestjs/swagger';

export class HealthDependencyDto {
  @ApiProperty({ enum: ['up', 'down'], example: 'up' })
  status!: 'up' | 'down';
}

export class HealthResponseDto {
  @ApiProperty({ enum: ['ok', 'error'], example: 'ok' })
  status!: 'ok' | 'error';

  @ApiProperty({ enum: ['live', 'ready'], example: 'live' })
  check!: 'live' | 'ready';

  @ApiProperty({
    required: false,
    example: { postgres: { status: 'up' }, sqs: { status: 'up' } },
  })
  details?: {
    postgres: HealthDependencyDto;
    sqs: HealthDependencyDto;
  };
}
