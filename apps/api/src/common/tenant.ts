import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ENV, type Env } from '../config/env.js';

export const DEV_TENANT_HEADER = 'x-dev-organization-id';

const IS_PUBLIC = Symbol('IS_PUBLIC');

/** Marks a route as reachable without organization context (health checks only). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

type TenantRequest = FastifyRequest & { organizationId?: string };

const organizationIdSchema = z.uuid();

/**
 * Global guard: every route requires an organization unless marked @Public() (deny by default).
 *
 * Temporary resolution (ADR 003): the organization comes from the x-dev-organization-id header,
 * accepted only when DEV_TENANT_HEADER=true (refused in production by env validation).
 * Better Auth will replace this with session + membership checks; routes will not change.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ENV) private readonly env: Env,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<TenantRequest>();
    if (!this.env.DEV_TENANT_HEADER) {
      throw new UnauthorizedException('Authentication required');
    }

    const parsed = organizationIdSchema.safeParse(request.headers[DEV_TENANT_HEADER]);
    if (!parsed.success) {
      throw new UnauthorizedException('Missing or invalid organization');
    }

    request.organizationId = parsed.data;
    return true;
  }
}

/** Injects the organization resolved by TenantGuard. */
export const OrganizationId = createParamDecorator((_: unknown, context: ExecutionContext) => {
  const { organizationId } = context.switchToHttp().getRequest<TenantRequest>();
  // Unreachable unless a route is wrongly marked @Public(): fail loudly rather than run unscoped.
  if (!organizationId) throw new UnauthorizedException('Missing or invalid organization');
  return organizationId;
});
