import { describe, expect, it } from 'vitest';
import { listPostsQuerySchema, POST_BODY_MAX_LENGTH, updatePostSchema } from '../src/index.js';

describe('listPostsQuerySchema', () => {
  it('defaults the page size and coerces query strings', () => {
    expect(listPostsQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(listPostsQuerySchema.parse({ limit: '5' })).toEqual({ limit: 5 });
  });

  it('rejects a non-uuid cursor and out-of-range limits', () => {
    expect(listPostsQuerySchema.safeParse({ cursor: 'abc' }).success).toBe(false);
    expect(listPostsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(listPostsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });
});

describe('updatePostSchema', () => {
  it('trims the body', () => {
    expect(updatePostSchema.parse({ body: '  hello  ' })).toEqual({ body: 'hello' });
  });

  it('rejects empty, too long and unknown fields', () => {
    expect(updatePostSchema.safeParse({ body: '   ' }).success).toBe(false);
    expect(updatePostSchema.safeParse({ body: 'x'.repeat(POST_BODY_MAX_LENGTH + 1) }).success).toBe(
      false,
    );
    // Clients cannot move a post to another tenant or workspace through the body.
    expect(
      updatePostSchema.safeParse({ body: 'ok', organizationId: crypto.randomUUID() }).success,
    ).toBe(false);
  });
});
