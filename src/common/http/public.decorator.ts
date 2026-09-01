import { SetMetadata } from '@nestjs/common';

export const PUBLIC_ROUTE = 'public-route';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_ROUTE, true);
