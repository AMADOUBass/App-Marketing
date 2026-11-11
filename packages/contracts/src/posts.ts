import { z } from 'zod';

/** Storage limit for a post body. Per-platform limits come from the capability registry, not here. */
export const POST_BODY_MAX_LENGTH = 20_000;

export const postIdSchema = z.uuid();

export const postSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  body: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type PostDto = z.infer<typeof postSchema>;

export const listPostsQuerySchema = z.object({
  /** Id of the last post of the previous page (UUIDv7 ids sort by creation time). */
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListPostsQuery = z.infer<typeof listPostsQuerySchema>;

export const postPageSchema = z.object({
  items: z.array(postSchema),
  /** Pass as `cursor` to get the next page; null on the last page. */
  nextCursor: z.uuid().nullable(),
});
export type PostPage = z.infer<typeof postPageSchema>;

export const updatePostSchema = z.strictObject({
  body: z.string().trim().min(1).max(POST_BODY_MAX_LENGTH),
});
export type UpdatePostInput = z.infer<typeof updatePostSchema>;
