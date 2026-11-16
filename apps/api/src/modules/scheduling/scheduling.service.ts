import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  CANCELLABLE_STATES,
  MAX_SCHEDULE_AHEAD_DAYS,
  type PublicationTargetDto,
  type PublicationTargetList,
  type SchedulePostInput,
  type SchedulingIssue,
} from '@ponctua/contracts';
import type { Db, IdempotentResult, PublicationState, PublicationTarget } from '@ponctua/db';
import { checkDraftForPlatform } from '@ponctua/integrations';
import { DB } from '../../common/db.module.js';
import { idempotentRequest } from '../../common/idempotency.js';
import { PostsService } from '../content/posts.service.js';
import { SocialAccountsService } from '../integrations/social-accounts.service.js';

/** States a target can be (re)scheduled from: nothing has been handed to the queue. */
const RESCHEDULABLE: readonly PublicationState[] = ['draft', 'scheduled', 'cancelled'];

function toDto(target: PublicationTarget): PublicationTargetDto {
  return {
    id: target.id,
    postId: target.postId,
    socialAccountId: target.socialAccountId,
    state: target.state,
    scheduledAt: target.scheduledAt?.toISOString() ?? null,
    updatedAt: target.updatedAt.toISOString(),
  };
}

/** Same answer whether the target does not exist or belongs to another organization. */
const targetNotFound = () => new NotFoundException('Publication target not found');

/**
 * Scheduling module (CLAUDE.md section 4): owns publication targets. Posts and social accounts are read
 * through their modules' public services (rule 5). PostgreSQL is the source of truth: the scheduler
 * picks scheduled targets up from here (ADR 005).
 */
@Injectable()
export class SchedulingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly posts: PostsService,
    private readonly accounts: SocialAccountsService,
  ) {}

  /**
   * Schedules a post on accounts of its workspace, once per Idempotency-Key. Every account is checked
   * first (same workspace, connected, post valid for the platform): any issue -> 422, nothing written.
   */
  async schedule(
    organizationId: string,
    postId: string,
    input: SchedulePostInput,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<IdempotentResult<PublicationTargetList>> {
    const post = await this.posts.get(organizationId, postId); // 404 if not ours
    const accounts = await this.accounts.findByIds(organizationId, input.socialAccountIds);
    if (accounts.length !== input.socialAccountIds.length) {
      throw new NotFoundException('Social account not found');
    }

    const scheduledAt = new Date(input.scheduledAt);
    const issues: SchedulingIssue[] = [];
    if (scheduledAt.getTime() <= now.getTime()) {
      issues.push({ socialAccountId: null, code: 'schedule.in_past' });
    }
    if (scheduledAt.getTime() > now.getTime() + MAX_SCHEDULE_AHEAD_DAYS * 24 * 60 * 60 * 1000) {
      issues.push({ socialAccountId: null, code: 'schedule.too_far' });
    }
    for (const account of accounts) {
      const issue = (code: string) => issues.push({ socialAccountId: account.id, code });
      if (account.workspaceId !== post.workspaceId) issue('account.other_workspace');
      if (!account.connected) issue('account.not_connected');
      for (const found of checkDraftForPlatform(account.platform, {
        text: post.body,
        imageUrl: post.imageUrl,
      })) {
        issue(found.code);
      }
    }
    if (issues.length > 0) {
      throw new UnprocessableEntityException({ message: 'The post cannot be scheduled', issues });
    }

    return this.db.idempotent(
      organizationId,
      idempotentRequest(idempotencyKey, `POST /posts/${postId}/schedule`, input),
      async (tx) => {
        const items: PublicationTargetDto[] = [];
        for (const socialAccountId of input.socialAccountIds) {
          const existing = await tx.publicationTarget.findUnique({
            where: { postId_socialAccountId: { postId, socialAccountId } },
          });
          if (existing && !RESCHEDULABLE.includes(existing.state)) {
            // Already queued, publishing or done: changing it now could publish twice (rule 6).
            throw new ConflictException(
              `Already ${existing.state} on this account: it can no longer be rescheduled`,
            );
          }
          const target = existing
            ? await tx.publicationTarget.update({
                where: { id: existing.id },
                data: { state: 'scheduled', scheduledAt },
              })
            : await tx.publicationTarget.create({
                data: { organizationId, postId, socialAccountId, state: 'scheduled', scheduledAt },
              });
          items.push(toDto(target));
        }
        return { status: 201, body: { items } };
      },
    );
  }

  /**
   * Cancels a target that has not been handed to the queue yet. Cancelling twice is fine; a target
   * already queued, publishing or done cannot be cancelled (409): it may already be on the platform.
   */
  async cancel(organizationId: string, targetId: string): Promise<PublicationTargetDto> {
    return this.db.withTenant(organizationId, async (tx) => {
      const { count } = await tx.publicationTarget.updateMany({
        where: { id: targetId, state: { in: [...CANCELLABLE_STATES] } },
        data: { state: 'cancelled' },
      });
      const target = await tx.publicationTarget.findUnique({ where: { id: targetId } });
      if (!target) throw targetNotFound();
      if (count === 0 && target.state !== 'cancelled') {
        throw new ConflictException(`Already ${target.state}: it can no longer be cancelled`);
      }
      return toDto(target);
    });
  }

  /** Targets of the given posts (the ones a page shows), oldest first per post. */
  async list(organizationId: string, postIds: readonly string[]): Promise<PublicationTargetList> {
    const rows = await this.db.withTenant(organizationId, (tx) =>
      tx.publicationTarget.findMany({
        where: { postId: { in: [...postIds] } },
        orderBy: [{ postId: 'asc' }, { id: 'asc' }],
      }),
    );
    return { items: rows.map(toDto) };
  }
}
