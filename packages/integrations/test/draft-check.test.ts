import { describe, expect, it } from 'vitest';
import { checkDraftForPlatform, PUBLISHABLE_PLATFORMS } from '../src/index.js';

const codes = (...args: Parameters<typeof checkDraftForPlatform>) =>
  checkDraftForPlatform(...args).map((issue) => issue.code);

describe('checking a draft before scheduling', () => {
  it('Instagram needs an image on a public HTTPS URL', () => {
    expect(codes('instagram', { text: 'hello', imageUrl: null })).toEqual(['media.required']);
    expect(codes('instagram', { text: 'hello', imageUrl: 'not a url' })).toEqual([
      'image.url_invalid',
    ]);
    expect(codes('instagram', { text: 'hi', imageUrl: 'http://cdn.example.com/a.jpg' })).toEqual([
      'image.url_not_https',
    ]);
    expect(codes('instagram', { text: 'hi', imageUrl: 'https://localhost/a.jpg' })).toEqual([
      'image.url_not_public',
    ]);
    expect(codes('instagram', { text: 'hi', imageUrl: 'https://cdn.example.com/a.jpg' })).toEqual(
      [],
    );
  });

  it('platforms without an adapter cannot be scheduled yet', () => {
    expect(PUBLISHABLE_PLATFORMS).toEqual(['instagram']);
    for (const platform of ['facebook', 'threads', 'youtube', 'linkedin', 'tiktok'] as const) {
      expect(codes(platform, { text: 'hello', imageUrl: null })).toEqual(['platform.unavailable']);
    }
  });
});
