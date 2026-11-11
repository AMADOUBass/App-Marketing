import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useSession } from '../src/lib/session';
import { mockApi, ORG_ID, renderApp } from './helpers';

describe('dev sign-in', () => {
  it('sends a visitor without organization to the sign-in page', async () => {
    const { history } = renderApp('/posts');

    expect(await screen.findByRole('heading', { level: 1, name: 'Connexion' })).toBeTruthy();
    expect(history.location.pathname).toBe('/login');
  });

  it('rejects an invalid organization id with an accessible error', async () => {
    renderApp('/login');
    const input = await screen.findByLabelText("Identifiant de l'organisation");

    await userEvent.type(input, 'not-a-uuid');
    await userEvent.click(screen.getByRole('button', { name: 'Continuer' }));

    expect(screen.getByRole('alert').textContent).toBe(
      'Saisissez un identifiant valide (format UUID).',
    );
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toContain(screen.getByRole('alert').id);
    expect(useSession.getState().organizationId).toBeNull();
  });

  it('accepts a valid organization id and opens the posts page', async () => {
    mockApi({ body: { items: [], nextCursor: null } });
    const { history } = renderApp('/login');

    await userEvent.type(await screen.findByLabelText("Identifiant de l'organisation"), ORG_ID);
    await userEvent.click(screen.getByRole('button', { name: 'Continuer' }));

    await waitFor(() => {
      expect(history.location.pathname).toBe('/posts');
    });
    expect(useSession.getState().organizationId).toBe(ORG_ID);
  });
});
