import { postPageSchema } from '@app/contracts';
import { Button, Card, CardContent } from '@app/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, apiGet } from '../lib/api';
import { useSession } from '../lib/session';

const PAGE_SIZE = 20;

export function PostsPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const organizationId = useSession((state) => state.organizationId);
  const signOut = useSession((state) => state.signOut);

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

  // The organization was rejected (e.g. dev header disabled): back to sign-in.
  const unauthorized = posts.error instanceof ApiError && posts.error.status === 401;
  useEffect(() => {
    if (!unauthorized) return;
    signOut();
    void navigate({ to: '/login' });
  }, [unauthorized, signOut, navigate]);

  const dateFormat = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const items = posts.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t('posts.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('posts.organization', { id: organizationId })}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            signOut();
            void navigate({ to: '/login' });
          }}
        >
          {t('posts.signOut')}
        </Button>
      </div>

      {/* Polite live region: loading and result states are announced without moving focus. */}
      <div aria-live="polite" aria-busy={posts.isPending}>
        {posts.isPending && <p>{t('posts.loading')}</p>}

        {posts.isError && !unauthorized && (
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
