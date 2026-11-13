import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ListPostsQuery, PostDto, PostPage, UpdatePostInput } from '@ponctua/contracts';
import type { Db, Post } from '@ponctua/db';
import { DB } from '../../common/db.module.js';

// Same message whether the post does not exist or belongs to another organization:
// the API must not reveal that an id exists elsewhere.
const notFound = () => new NotFoundException('Post not found');

function toDto(post: Post): PostDto {
  return {
    id: post.id,
    workspaceId: post.workspaceId,
    body: post.body,
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
  };
}

@Injectable()
export class PostsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Newest first. UUIDv7 ids sort by creation time, so the id is the cursor. */
  async list(organizationId: string, query: ListPostsQuery): Promise<PostPage> {
    const rows = await this.db.withTenant(organizationId, (tx) =>
      tx.post.findMany({
        ...(query.cursor ? { where: { id: { lt: query.cursor } } } : {}),
        orderBy: { id: 'desc' },
        take: query.limit + 1,
      }),
    );

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(toDto),
      nextCursor: rows.length > query.limit && last ? last.id : null,
    };
  }

  async get(organizationId: string, id: string): Promise<PostDto> {
    const post = await this.db.withTenant(organizationId, (tx) =>
      tx.post.findUnique({ where: { id } }),
    );
    if (!post) throw notFound();
    return toDto(post);
  }

  async update(organizationId: string, id: string, input: UpdatePostInput): Promise<PostDto> {
    const post = await this.db.withTenant(organizationId, async (tx) => {
      // updateMany + count: a row hidden by RLS simply matches nothing.
      const { count } = await tx.post.updateMany({ where: { id }, data: { body: input.body } });
      return count === 0 ? null : tx.post.findUnique({ where: { id } });
    });
    if (!post) throw notFound();
    return toDto(post);
  }
}
