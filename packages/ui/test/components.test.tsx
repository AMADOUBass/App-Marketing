import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button, Card, CardTitle, Input, Label } from '../src/index';

afterEach(cleanup);

describe('@app/ui', () => {
  it('Button renders a native button, or its child with asChild', () => {
    render(
      <>
        <Button>Save</Button>
        <Button asChild>
          <a href="/posts">Posts</a>
        </Button>
      </>,
    );

    expect(screen.getByRole('button', { name: 'Save' }).tagName).toBe('BUTTON');
    expect(screen.getByRole('link', { name: 'Posts' }).getAttribute('data-slot')).toBe('button');
  });

  it('Label is programmatically associated with its Input', () => {
    render(
      <>
        <Label htmlFor="org">Organization</Label>
        <Input id="org" />
      </>,
    );

    expect(screen.getByLabelText('Organization').tagName).toBe('INPUT');
  });

  it('CardTitle is a level-2 heading (pages keep a single h1)', () => {
    render(
      <Card>
        <CardTitle>Title</CardTitle>
      </Card>,
    );

    expect(screen.getByRole('heading', { level: 2, name: 'Title' })).toBeTruthy();
  });
});
