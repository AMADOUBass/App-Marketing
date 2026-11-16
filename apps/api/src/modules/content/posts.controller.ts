import { Body, Controller, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import {
  type CreatePostInput,
  createPostSchema,
  type ListPostsQuery,
  listPostsQuerySchema,
  type PostDto,
  postIdSchema,
  type PostPage,
  type UpdatePostInput,
  updatePostSchema,
} from '@ponctua/contracts';
import type { FastifyReply } from 'fastify';
import { IdempotencyKey, sendIdempotent } from '../../common/idempotency.js';
import { OrganizationId } from '../../common/tenant.js';
import { PostsService } from './posts.service.js';

@Controller({ path: 'posts', version: '1' })
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  @Get()
  list(
    @OrganizationId() organizationId: string,
    @Query({ schema: listPostsQuerySchema }) query: ListPostsQuery,
  ): Promise<PostPage> {
    return this.posts.list(organizationId, query);
  }

  /** 201 with the post; the same Idempotency-Key replays it (Idempotent-Replayed: true). */
  @Post()
  async create(
    @OrganizationId() organizationId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: createPostSchema }) input: CreatePostInput,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<PostDto> {
    return sendIdempotent(reply, await this.posts.create(organizationId, input, idempotencyKey));
  }

  @Get(':id')
  get(
    @OrganizationId() organizationId: string,
    @Param('id', { schema: postIdSchema }) id: string,
  ): Promise<PostDto> {
    return this.posts.get(organizationId, id);
  }

  @Patch(':id')
  update(
    @OrganizationId() organizationId: string,
    @Param('id', { schema: postIdSchema }) id: string,
    @Body({ schema: updatePostSchema }) input: UpdatePostInput,
  ): Promise<PostDto> {
    return this.posts.update(organizationId, id, input);
  }
}
