import { Inject, Injectable } from '@nestjs/common';
import type { Db, Platform } from '@ponctua/db';
import { DB } from '../../common/db.module.js';

/** What another module may know about a social account: never tokens (rule 3). */
export interface SocialAccountRef {
  id: string;
  workspaceId: string;
  platform: Platform;
  /** A sealed credential exists, so the worker can publish with it. */
  connected: boolean;
}

/**
 * Public service of the integrations module (rule 5): other modules read social accounts through it,
 * never through the tables.
 */
@Injectable()
export class SocialAccountsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The accounts among `ids` that belong to the organization (others are invisible, RLS). */
  async findByIds(organizationId: string, ids: readonly string[]): Promise<SocialAccountRef[]> {
    const rows = await this.db.withTenant(organizationId, (tx) =>
      tx.socialAccount.findMany({
        where: { id: { in: [...ids] } },
        select: {
          id: true,
          workspaceId: true,
          platform: true,
          credential: { select: { id: true } },
        },
      }),
    );
    return rows.map(({ credential, ...account }) => ({
      ...account,
      connected: credential !== null,
    }));
  }
}
