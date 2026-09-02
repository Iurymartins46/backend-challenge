import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../config/configuration';
import { PUBLIC_ROUTE } from '../../common/http/public.decorator';
import { ErrorCode } from '../../common/http/error-codes';
import { PROVIDER_IDENTITY_PORT, type ProviderIdentityPort } from './provider-identity.port';
import { PROVIDER_SCOPES } from './provider-scopes.decorator';

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(PROVIDER_IDENTITY_PORT) private readonly identity: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic || this.config.get('auth.mode', { infer: true }) === 'none') {
      return true;
    }

    const request = context.switchToHttp().getRequest<unknown>();
    const principal = await this.identity.identify(request);
    if (principal === null) {
      throw new UnauthorizedException({
        message: 'A bearer access token is required.',
        errors: [
          { code: ErrorCode.AuthTokenRequired, detail: 'A bearer access token is required.' },
        ],
      });
    }

    const requiredScopes =
      this.reflector.getAllAndOverride<readonly string[]>(PROVIDER_SCOPES, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (requiredScopes.some((scope) => !principal.scopes.includes(scope))) {
      throw new ForbiddenException({
        message: 'The provider lacks a required scope.',
        errors: [
          {
            code: ErrorCode.AuthInsufficientScope,
            detail: 'The provider lacks a required scope.',
          },
        ],
      });
    }

    const operationProviderId = providerIdFromRequest(request);
    if (operationProviderId !== undefined && operationProviderId !== principal.providerId) {
      throw new ForbiddenException({
        message: 'The authenticated provider does not match the operation.',
        errors: [
          {
            code: ErrorCode.AuthProviderMismatch,
            detail: 'The authenticated provider does not match the operation.',
          },
        ],
      });
    }

    return true;
  }
}

function providerIdFromRequest(request: unknown): string | undefined {
  if (typeof request !== 'object' || request === null) {
    return undefined;
  }
  const candidate = request as {
    body?: { providerId?: unknown };
    params?: { providerId?: unknown };
  };
  const providerId = candidate.body?.providerId ?? candidate.params?.providerId;
  return typeof providerId === 'string' && providerId.trim().length > 0 ? providerId : undefined;
}
