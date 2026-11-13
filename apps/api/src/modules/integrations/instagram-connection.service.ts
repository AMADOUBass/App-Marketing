import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { SocialAccountDto } from '@ponctua/contracts';
import type { Db } from '@ponctua/db';
import {
  buildLoginUrl,
  createGraphClient,
  exchangeCodeForToken,
  type FetchLike,
  GraphApiError,
  instagramCapabilities,
  listAssignedInstagramAccounts,
} from '@ponctua/integrations';
import type { Secret } from '@ponctua/vault';
import { createVaultSealer, type VaultSealer } from '@ponctua/vault/seal';
import { ZodError } from 'zod';
import { DB } from '../../common/db.module.js';
import { ENV, type Env } from '../../config/env.js';
import { signOAuthState, verifyOAuthState } from './oauth-state.js';

export const GRAPH_FETCH = Symbol('GRAPH_FETCH');

/** Safe diagnostic: error type, HTTP status, Meta codes, trace id, schema paths. Never values. */
function describeFailure(error: unknown): string {
  if (error instanceof GraphApiError) {
    return `GraphApiError http=${String(error.httpStatus)} code=${String(error.code)} subcode=${String(error.subcode)} type=${String(error.type)} fbtrace=${String(error.fbtraceId)}`;
  }
  if (error instanceof ZodError) {
    return `unexpected response shape at ${error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ')}`;
  }
  return error instanceof Error ? error.name : 'unknown error';
}

export type CallbackResult = 'connected' | 'cancelled' | 'invalid_state' | 'no_account' | 'failed';

interface InstagramConfig {
  appId: string;
  appSecret: Secret;
  configId: string;
  redirectUri: string;
  stateKey: Secret;
  webAppUrl: string;
  sealer: VaultSealer;
}

function instagramConfig(env: Env): InstagramConfig | null {
  if (
    !env.META_APP_ID ||
    !env.META_APP_SECRET ||
    !env.INSTAGRAM_CONFIG_ID ||
    !env.INSTAGRAM_REDIRECT_URI ||
    !env.OAUTH_STATE_SECRET ||
    !env.VAULT_MASTER_KEY_ID ||
    !env.VAULT_MASTER_PUBLIC_KEY ||
    !env.WEB_APP_URL
  ) {
    return null;
  }
  return {
    appId: env.META_APP_ID,
    appSecret: env.META_APP_SECRET,
    configId: env.INSTAGRAM_CONFIG_ID,
    redirectUri: env.INSTAGRAM_REDIRECT_URI,
    stateKey: env.OAUTH_STATE_SECRET,
    webAppUrl: env.WEB_APP_URL,
    sealer: createVaultSealer({
      masterKeyId: env.VAULT_MASTER_KEY_ID,
      masterPublicKey: env.VAULT_MASTER_PUBLIC_KEY,
    }),
  };
}

/**
 * Connects Instagram professional accounts (Unified Login, ADR 007). The access token goes straight from
 * Meta's answer into the vault, sealed (ADR 006): it is never returned, logged or stored in clear.
 */
@Injectable()
export class InstagramConnectionService {
  private readonly logger = new Logger(InstagramConnectionService.name);
  private readonly config: InstagramConfig | null;
  private readonly graph;

  constructor(
    @Inject(ENV) env: Env,
    @Inject(DB) private readonly db: Db,
    @Inject(GRAPH_FETCH) fetchImpl: FetchLike,
  ) {
    this.config = instagramConfig(env);
    this.graph = createGraphClient({ fetch: fetchImpl });
  }

  get webAppUrl(): string | null {
    return this.config?.webAppUrl ?? null;
  }

  private requireConfig(): InstagramConfig {
    if (!this.config)
      throw new ServiceUnavailableException('Instagram integration is not configured');
    return this.config;
  }

  /** Login URL for the current organization; the account will land in `workspaceId` (or the first workspace). */
  async loginUrl(organizationId: string, workspaceId?: string): Promise<string> {
    const config = this.requireConfig();
    const workspace = await this.db.withTenant(organizationId, (tx) =>
      tx.workspace.findFirst({
        where: workspaceId ? { id: workspaceId } : {},
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      }),
    );
    if (!workspace) throw new ConflictException('No workspace to attach the account to');

    return buildLoginUrl({
      appId: config.appId,
      configId: config.configId,
      redirectUri: config.redirectUri,
      state: signOAuthState(config.stateKey, { organizationId, workspaceId: workspace.id }),
      forceLoginChoice: true,
    });
  }

  async handleCallback(query: {
    code?: string | undefined;
    state?: string | undefined;
    error?: string | undefined;
  }): Promise<CallbackResult> {
    const config = this.requireConfig();
    const context = verifyOAuthState(config.stateKey, query.state);
    if (!context) return 'invalid_state';
    if (query.error || !query.code) return 'cancelled';

    let step: 'code_exchange' | 'list_accounts' | 'store' = 'code_exchange';
    try {
      const token = await exchangeCodeForToken(this.graph, {
        appId: config.appId,
        appSecret: config.appSecret,
        code: query.code,
        // Must be identical to the redirect_uri of the login dialog (else 100 / 36008).
        redirectUri: config.redirectUri,
      });
      step = 'list_accounts';
      const accounts = await listAssignedInstagramAccounts(this.graph, token.accessToken);
      if (accounts.length === 0) return 'no_account';

      step = 'store';

      await this.db.withTenant(context.organizationId, async (tx) => {
        for (const account of accounts) {
          const socialAccount = await tx.socialAccount.upsert({
            where: {
              organizationId_platform_externalAccountId: {
                organizationId: context.organizationId,
                platform: 'instagram',
                externalAccountId: account.id,
              },
            },
            create: {
              organizationId: context.organizationId,
              workspaceId: context.workspaceId,
              platform: 'instagram',
              externalAccountId: account.id,
              displayName: account.username ?? account.id,
            },
            update: { displayName: account.username ?? account.id },
          });
          await config.sealer.storeCredential(tx, {
            organizationId: context.organizationId,
            socialAccountId: socialAccount.id,
            tokens: { accessToken: token.accessToken, refreshToken: null },
            scopes: [...instagramCapabilities.permissions.value],
            expiresAt: token.expiresAt,
          });
        }
      });
      return 'connected';
    } catch (error) {
      // Step and codes only: the platform message, the code and the token stay out of the logs.
      this.logger.warn(`Instagram connection failed at ${step}: ${describeFailure(error)}`);
      return 'failed';
    }
  }

  async listAccounts(organizationId: string): Promise<SocialAccountDto[]> {
    const accounts = await this.db.withTenant(organizationId, (tx) =>
      tx.socialAccount.findMany({
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          workspaceId: true,
          platform: true,
          displayName: true,
          externalAccountId: true,
          credential: { select: { id: true } },
        },
      }),
    );
    return accounts.map(({ credential, ...account }) => ({
      ...account,
      connected: credential !== null,
    }));
  }
}
