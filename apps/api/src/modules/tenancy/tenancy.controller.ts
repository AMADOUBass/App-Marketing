import { Body, Controller, Get, Inject, Post, Req, UnauthorizedException } from '@nestjs/common';
import {
  type CreateOrganizationInput,
  createOrganizationSchema,
  type MeResponse,
  type UserOrganization,
} from '@ponctua/contracts';
import type { Db } from '@ponctua/db';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyRequest } from 'fastify';
import { DB } from '../../common/db.module.js';
import { CurrentUserId, SessionOnly } from '../../common/tenant.js';
import { AUTH, type Auth } from '../identity/auth.js';

@SessionOnly()
@Controller({ version: '1' })
export class TenancyController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AUTH) private readonly auth: Auth,
  ) {}

  /** The signed-in user and their organizations (to pick the one to work in). */
  @Get('me')
  async me(@CurrentUserId() userId: string, @Req() request: FastifyRequest): Promise<MeResponse> {
    const session = await this.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session) throw new UnauthorizedException('Authentication required');
    return {
      user: { id: userId, name: session.user.name, email: session.user.email },
      organizations: await this.db.directory.listOrganizations(userId),
    };
  }

  /** Onboarding: the creator becomes owner; a first workspace with the same name is created. */
  @Post('organizations')
  async create(
    @CurrentUserId() userId: string,
    @Body({ schema: createOrganizationSchema }) input: CreateOrganizationInput,
  ): Promise<UserOrganization> {
    const organization = await this.db.createOrganizationWithOwner({
      name: input.name,
      ownerUserId: userId,
      workspaceName: input.name,
    });
    return { organizationId: organization.id, name: organization.name, role: 'owner' };
  }
}
