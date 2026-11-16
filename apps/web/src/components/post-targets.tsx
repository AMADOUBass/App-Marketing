import {
  CANCELLABLE_STATES,
  type PublicationStateDto,
  type PublicationTargetDto,
  publicationTargetSchema,
  type SocialAccountDto,
} from '@ponctua/contracts';
import { Button } from '@ponctua/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { apiRequest } from '../lib/api';
import { useSession } from '../lib/session';

/** States that ask the user to look (an error, or a human decision). */
const ATTENTION: readonly PublicationStateDto[] = ['failed', 'needs_action', 'unknown_outcome'];

export const TARGETS_QUERY_KEY = 'publication-targets';

/** States whose reason helps the user (what went wrong, or why it waits). */
const SHOW_REASON: readonly PublicationStateDto[] = [
  'scheduled',
  'queued',
  'retrying',
  'failed',
  'needs_action',
  'unknown_outcome',
];

/** Where a post goes (one line per social account) and how far it got. */
export function PostTargets({
  targets,
  accounts,
}: {
  targets: PublicationTargetDto[];
  accounts: ReadonlyMap<string, SocialAccountDto>;
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const organizationId = useSession((state) => state.organizationId);
  const cancel = useMutation({
    mutationFn: (targetId: string) =>
      apiRequest(`/publication-targets/${targetId}/cancel`, publicationTargetSchema, {
        method: 'POST',
        organizationId,
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: [TARGETS_QUERY_KEY] }),
  });
  /** Known reason codes are translated; a new one falls back to a generic sentence. */
  const reasonText = (code: string) => {
    const key = `targets.reasons.${code}`;
    return i18n.exists(key) ? t(key as 'targets.reasons.other') : t('targets.reasons.other');
  };
  const dateFormat = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  if (targets.length === 0) return null;

  return (
    <div className="grid gap-2">
      <ul aria-label={t('targets.listLabel')} className="grid gap-1">
        {targets.map((target) => {
          const account = accounts.get(target.socialAccountId);
          const where = account
            ? t('targets.where', {
                platform: t(`platforms.${account.platform}`),
                name: account.displayName,
              })
            : t('targets.unknownAccount');
          const cancellable = (CANCELLABLE_STATES as readonly string[]).includes(target.state);
          return (
            <li
              key={target.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm"
            >
              <span>
                <span className="font-medium">{where}</span>
                <span className="mx-1 text-muted-foreground">·</span>
                <span
                  className={ATTENTION.includes(target.state) ? 'font-medium text-destructive' : ''}
                >
                  {t(`targets.states.${target.state}`)}
                </span>
                {target.scheduledAt && target.state === 'scheduled' && (
                  <>
                    {' '}
                    <time dateTime={target.scheduledAt}>
                      {t('targets.at', { date: dateFormat.format(new Date(target.scheduledAt)) })}
                    </time>
                  </>
                )}
                {target.retryAt && target.state === 'retrying' && (
                  <>
                    {' '}
                    <time dateTime={target.retryAt}>
                      {t('targets.at', { date: dateFormat.format(new Date(target.retryAt)) })}
                    </time>
                  </>
                )}
                {target.statusReason && SHOW_REASON.includes(target.state) && (
                  <span className="block text-muted-foreground">
                    {reasonText(target.statusReason)}
                  </span>
                )}
              </span>
              {cancellable && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={cancel.isPending}
                  aria-label={t('targets.cancelNamed', { where })}
                  onClick={() => {
                    cancel.mutate(target.id);
                  }}
                >
                  {t('targets.cancel')}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {cancel.isError && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {t('targets.cancelError')}
        </p>
      )}
    </div>
  );
}
