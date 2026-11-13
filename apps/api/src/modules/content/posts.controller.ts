import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import {
  type ListPostsQuery,
  listPostsQuerySchema,
  type PostDto,
  postIdSchema,
  type PostPage,
  type UpdatePostInput,
  updatePostSchema,
} from '@ponctua/contracts';
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
