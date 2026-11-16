import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ORGANIZATION_HEADER } from '../src/lib/api';
import { useSession } from '../src/lib/session';
import { me, mockApi, ORG_ID, post, renderApp } from './helpers';

const ACCOUNT = {
  id: '0195f000-0000-7000-8000-000000000301',
  workspaceId: '0195f000-0000-7000-8000-0000000000a1',
  platform: 'instagram',
  displayName: 'boulangerie',
  externalAccountId: '17841472428926955',
  connected: true,
};

function target(
  postId: string,
  state: string,
  id = crypto.randomUUID(),
  extra: { retryAt?: string; statusReason?: string } = {},
) {
  return {
    id,
    postId,
    socialAccountId: ACCOUNT.id,
    state,
    scheduledAt: '2026-11-20T19:30:00.000Z',
    retryAt: extra.retryAt ?? null,
    statusReason: extra.statusReason ?? null,
    updatedAt: '2026-11-16T10:00:00.000Z',
  };
}

beforeEach(() => {
  useSession.getState().selectOrganization(ORG_ID);
});

describe('where each post goes, and how far it got', () => {
  it('asks the targets of the shown posts only, for the current organization', async () => {
    const first = post('Croissants du samedi');
    const second = post('Horaires des fêtes', 1);
    const api = mockApi({
      '/api/v1/me': { body: me() },
      '/api/v1/posts': { body: { items: [first, second], nextCursor: null } },
      '/api/v1/publication-targets': {
        body: { items: [target(first.id, 'scheduled'), target(second.id, 'published')] },
      },
      '/api/v1/social-accounts': { body: { items: [ACCOUNT] } },
    });
    renderApp('/posts');

    expect(await screen.findByText('Programmé')).toBeTruthy();
    expect(screen.getByText('Publié')).toBeTruthy();
    expect(screen.getAllByText('Instagram · boulangerie')).toHaveLength(2);
    const [request] = api.to('/api/v1/publication-targets');
    expect(request?.url).toBe(`/api/v1/publication-targets?postId=${first.id}&postId=${second.id}`);
    expect(request?.headers.get(ORGANIZATION_HEADER)).toBe(ORG_ID);
  });

  it('shows the scheduled time, and flags what needs a look', async () => {
    const scheduled = post('À venir');
    const failed = post('Raté', 1);
    mockApi({
      '/api/v1/me': { body: me() },
      '/api/v1/posts': { body: { items: [scheduled, failed], nextCursor: null } },
      '/api/v1/publication-targets': {
        body: { items: [target(scheduled.id, 'scheduled'), target(failed.id, 'needs_action')] },
      },
      '/api/v1/social-accounts': { body: { items: [ACCOUNT] } },
    });
    renderApp('/posts');

    const time = await screen.findByText(/^le /);
    expect(time.tagName).toBe('TIME');
    expect(time.getAttribute('datetime')).toBe('2026-11-20T19:30:00.000Z');
    expect(screen.getByText('Action requise').className).toContain('text-destructive');
    // Only what has not left yet can be cancelled.
    expect(
      screen.getAllByRole('button', { name: 'Annuler la publication sur Instagram · boulangerie' }),
    ).toHaveLength(2);
  });

  it('cancels a scheduled publication, then shows it cancelled', async () => {
    const item = post('À annuler');
    const scheduled = target(item.id, 'scheduled');
    const api = mockApi({
      '/api/v1/me': { body: me() },
      '/api/v1/posts': { body: { items: [item], nextCursor: null } },
      '/api/v1/publication-targets': [
        { body: { items: [scheduled] } },
        { body: { items: [{ ...scheduled, state: 'cancelled' }] } },
      ],
      [`POST /api/v1/publication-targets/${scheduled.id}/cancel`]: {
        body: { ...scheduled, state: 'cancelled' },
      },
      '/api/v1/social-accounts': { body: { items: [ACCOUNT] } },
    });
    renderApp('/posts');

    const list = await screen.findByRole('list', { name: 'Comptes de publication' });
    await userEvent.click(
      within(list).getByRole('button', {
        name: 'Annuler la publication sur Instagram · boulangerie',
      }),
    );

    expect(await screen.findByText('Annulé')).toBeTruthy();
    const [cancel] = api.to(`/api/v1/publication-targets/${scheduled.id}/cancel`);
    expect(cancel?.headers.get(ORGANIZATION_HEADER)).toBe(ORG_ID);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Annuler la publication/ })).toBeNull();
    });
  });

  it('says so when it is too late to cancel (409)', async () => {
    const item = post('Trop tard');
    const scheduled = target(item.id, 'scheduled');
    mockApi({
      '/api/v1/me': { body: me() },
      '/api/v1/posts': { body: { items: [item], nextCursor: null } },
      '/api/v1/publication-targets': { body: { items: [scheduled] } },
      [`POST /api/v1/publication-targets/${scheduled.id}/cancel`]: {
        status: 409,
        body: { type: 'about:blank', title: 'Conflict', status: 409 },
      },
      '/api/v1/social-accounts': { body: { items: [ACCOUNT] } },
    });
    renderApp('/posts');

    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Annuler la publication sur Instagram · boulangerie',
      }),
    );

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Impossible d’annuler : la publication est peut-être déjà en cours.',
    );
  });

  it('explains why: what to do, when the next attempt is, a generic text for unknown codes', async () => {
    const reconnect = post('Compte à reconnecter');
    const retrying = post('Nouvel essai', 1);
    const odd = post('Code inconnu', 2);
    mockApi({
      '/api/v1/me': { body: me() },
      '/api/v1/posts': { body: { items: [reconnect, retrying, odd], nextCursor: null } },
      '/api/v1/publication-targets': {
        body: {
          items: [
            target(reconnect.id, 'needs_action', undefined, { statusReason: 'account.reconnect' }),
            target(retrying.id, 'retrying', undefined, {
              retryAt: '2026-11-20T19:45:00.000Z',
              statusReason: 'platform.transient',
            }),
            target(odd.id, 'failed', undefined, { statusReason: 'something.new' }),
          ],
        },
      },
      '/api/v1/social-accounts': { body: { items: [ACCOUNT] } },
    });
    renderApp('/posts');

    expect(
      await screen.findByText('Reconnectez le compte : son autorisation n’est plus valide.'),
    ).toBeTruthy();
    expect(screen.getByText('Nouvel essai prévu')).toBeTruthy();
    expect(
      screen.getByText('La plateforme ne répondait pas : un nouvel essai est prévu.'),
    ).toBeTruthy();
    const times = [...document.querySelectorAll('time')].map((t) => t.getAttribute('datetime'));
    expect(times).toContain('2026-11-20T19:45:00.000Z');
    expect(
      screen.getByText('Consultez le compte sur la plateforme, puis reprogrammez si besoin.'),
    ).toBeTruthy();
  });
});
