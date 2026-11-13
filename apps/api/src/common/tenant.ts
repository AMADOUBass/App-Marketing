import {
  BadRequestException,
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Db, OrganizationRole } from '@ponctua/db';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ENV, type Env } from '../config/env.js';
import { AUTH, type Auth } from '../modules/identity/auth.js';
import { DB } from './db.module.js';

/** The organization a signed-in user acts for (chosen in the web app, checked on every request). */
export const ORGANIZATION_HEADER = 'x-organization-id';
/** Temporary development fallback (ADR 003), removed once the web sign-in ships. */
export const DEV_TENANT_HEADER = 'x-dev-organization-id';

const IS_PUBLIC = Symbol('IS_PUBLIC');
const SESSION_ONLY = Symbol('SESSION_ONLY');

/** Reachable without any authentication (health checks, OAuth callbacks verified otherwise). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Needs a signed-in user but no organization (list or create organizations). */
export const SessionOnly = () => SetMetadata(SESSION_ONLY, true);

type TenantRequest = FastifyRequest & {
  userId?: string;
  organizationId?: string;
  organizationRole?: OrganizationRole;
};

const organizationIdSchema = z.uuid();

/**
 * Global guard, deny by default (ADR 008):
 * 1. a valid Better Auth session (httpOnly cookie) is required -> otherwise 401;
 * 2. the x-organization-id header names the organization -> the user must be a member -> otherwise 403.
 * The membership lookup runs inside withTenant(that organization): RLS still applies.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ENV) private readonly env: Env,
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(DB) private readonly db: Db,
  ) {}

  private flag(key: symbol, context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean | undefined>(key, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.flag(IS_PUBLIC, context)) return true;
    const request = context.switchToHttp().getRequest<TenantRequest>();

    const session = await this.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (session) {
      request.userId = session.user.id;
      if (this.flag(SESSION_ONLY, context)) return true;

      const parsed = organizationIdSchema.safeParse(request.headers[ORGANIZATION_HEADER]);
      if (!parsed.success) throw new BadRequestException(`${ORGANIZATION_HEADER} header required`);

      const membership = await this.db.withTenant(parsed.data, (tx) =>
        tx.membership.findFirst({ where: { userId: session.user.id }, select: { role: true } }),
      );
      if (!membership) throw new ForbiddenException('Not a member of this organization');

      request.organizationId = parsed.data;
      request.organizationRole = membership.role;
      return true;
    }

    // Development fallback (ADR 003): refused in production by env validation.
    if (this.env.DEV_TENANT_HEADER && !this.flag(SESSION_ONLY, context)) {
      const parsed = organizationIdSchema.safeParse(request.headers[DEV_TENANT_HEADER]);
      if (parsed.success) {
        request.organizationId = parsed.data;
        return true;
      }
    }
    throw new UnauthorizedException('Authentication required');
  }
}

/** Injects the organization resolved by TenantGuard. */
export const OrganizationId = createParamDecorator((_: unknown, context: ExecutionContext) => {
  const { organizationId } = context.switchToHttp().getRequest<TenantRequest>();
  // Unreachable unless a route is wrongly marked @Public(): fail loudly rather than run unscoped.
  if (!organizationId) throw new UnauthorizedException('Missing or invalid organization');
  return organizationId;
});

/** Injects the signed-in user's id (routes marked @SessionOnly() or organization routes). */
export const CurrentUserId = createParamDecorator((_: unknown, context: ExecutionContext) => {
  const { userId } = context.switchToHttp().getRequest<TenantRequest>();
  if (!userId) throw new UnauthorizedException('Authentication required');
  return userId;
});
