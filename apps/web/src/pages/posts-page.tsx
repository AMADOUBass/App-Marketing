import {
  postPageSchema,
  publicationTargetListSchema,
  type SocialAccountDto,
  socialAccountListSchema,
} from '@ponctua/contracts';
import { Button, Card, CardContent } from '@ponctua/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { PostTargets, TARGETS_QUERY_KEY } from '../components/post-targets';
import { apiGet } from '../lib/api';
import { useSession } from '../lib/session';

const PAGE_SIZE = 20;

export function PostsPage() {
  const { t, i18n } = useTranslation();
  const organizationId = useSession((state) => state.organizationId);

  const posts = useInfiniteQuery({
    queryKey: ['posts', organizationId],
    enabled: organizationId !== null,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const cursor = pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : '';
      return apiGet(
        `/posts?limit=${String(PAGE_SIZE)}${cursor}`,
        postPageSchema,
        organizationId ?? '',
        signal,
      );
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const dateFormat = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const items = posts.data?.pages.flatMap((page) => page.items) ?? [];
  const postIds = items.map((post) => post.id);

  // Where each shown post goes, and how far it got (one request for the whole page).
  const targets = useQuery({
    queryKey: [TARGETS_QUERY_KEY, organizationId, postIds],
    enabled: organizationId !== null && postIds.length > 0,
    queryFn: ({ signal }) =>
      apiGet(
        `/publication-targets?${postIds.map((id) => `postId=${id}`).join('&')}`,
        publicationTargetListSchema,
        organizationId ?? '',
        signal,
      ),
  });
  // Same query as the accounts page: names and platforms for the target lines.
  const accounts = useQuery({
    queryKey: ['social-accounts', organizationId],
    enabled: organizationId !== null && postIds.length > 0,
    queryFn: ({ signal }) =>
      apiGet('/social-accounts', socialAccountListSchema, organizationId ?? '', signal),
  });
  const accountsById = useMemo(
    () => new Map<string, SocialAccountDto>((accounts.data?.items ?? []).map((a) => [a.id, a])),
    [accounts.data],
  );
  const targetsOf = (postId: string) =>
    (targets.data?.items ?? []).filter((target) => target.postId === postId);

  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold">{t('posts.title')}</h1>

      {/* Polite live region: loading and result states are announced without moving focus. */}
      <div aria-live="polite" aria-busy={posts.isPending}>
        {posts.isPending && <p>{t('posts.loading')}</p>}

        {posts.isError && (
          <div role="alert" className="grid justify-items-start gap-3">
            <p>{t('posts.error')}</p>
            <Button variant="outline" onClick={() => void posts.refetch()}>
              {t('posts.retry')}
            </Button>
          </div>
        )}

        {posts.isSuccess && items.length === 0 && <p>{t('posts.empty')}</p>}
      </div>

      {items.length > 0 && (
        <ul className="grid gap-3">
          {items.map((post) => (
            <li key={post.id}>
              <Card className="gap-2 py-4">
                <CardContent className="grid gap-2">
                  <p className="whitespace-pre-line">{post.body}</p>
                  <p className="text-sm text-muted-foreground">
                    <time dateTime={post.updatedAt}>
                      {t('posts.updatedAt', { date: dateFormat.format(new Date(post.updatedAt)) })}
                    </time>
                  </p>
                  <PostTargets targets={targetsOf(post.id)} accounts={accountsById} />
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {posts.hasNextPage && (
        <Button
          variant="outline"
          className="mt-6"
          disabled={posts.isFetchingNextPage}
          onClick={() => void posts.fetchNextPage()}
        >
          {posts.isFetchingNextPage ? t('posts.loadingMore') : t('posts.loadMore')}
        </Button>
      )}
    </>
  );
}
