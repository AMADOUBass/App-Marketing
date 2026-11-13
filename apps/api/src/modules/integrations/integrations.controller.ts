import { Controller, Get, Query, Redirect } from '@nestjs/common';
import {
  type InstagramConnectQuery,
  instagramConnectQuerySchema,
  type InstagramConnectResponse,
  type OauthCallbackQuery,
  oauthCallbackQuerySchema,
  type SocialAccountList,
} from '@app/contracts';
import { OrganizationId, Public } from '../../common/tenant.js';
import { InstagramConnectionService } from './instagram-connection.service.js';

@Controller({ version: '1' })
export class IntegrationsController {
  constructor(private readonly instagram: InstagramConnectionService) {}

  @Get('social-accounts')
  async list(@OrganizationId() organizationId: string): Promise<SocialAccountList> {
    return { items: await this.instagram.listAccounts(organizationId) };
  }

  @Get('integrations/instagram/connect')
  async connect(
    @OrganizationId() organizationId: string,
    @Query({ schema: instagramConnectQuerySchema }) query: InstagramConnectQuery,
  ): Promise<InstagramConnectResponse> {
    return { loginUrl: await this.instagram.loginUrl(organizationId, query.workspaceId) };
  }

  /**
   * Meta redirects the browser here. No tenant header on this request: the signed state carries the
   * organization (see oauth-state.ts). Always ends with a redirect to the web app, never with token data.
   */
  @Public()
  @Get('integrations/instagram/callback')
  @Redirect()
  async callback(@Query({ schema: oauthCallbackQuerySchema }) query: OauthCallbackQuery) {
    const result = await this.instagram.handleCallback(query);
    const target = new URL('/accounts', this.instagram.webAppUrl ?? 'http://localhost:5173');
    target.searchParams.set('instagram', result);
    return { url: target.toString(), statusCode: 302 };
  }
}
