import { ZodError } from 'zod';
import { describe, expect, it } from 'vitest';
import { classifyInstagramError, GraphApiError, GraphNetworkError } from '../src/index.js';

const api = (
  code: number | null,
  subcode: number | null = null,
  httpStatus = 400,
  type: string | null = null,
) => new GraphApiError(httpStatus, code, subcode, type, 'trace');

describe('classifyInstagramError (from Meta error tables only)', () => {
  it.each([
    ['daily publishing limit 9/2207042', api(9, 2207042), 'quota'],
    ['too many calls (4)', api(4), 'quota'],
    ['user too many calls (17)', api(17), 'quota'],
    ['application limit (341)', api(341), 'quota'],
    ['server error -1/2207001', api(-1, 2207001), 'transient'],
    ['download too slow -2/2207003', api(-2, 2207003), 'transient'],
    ['not ready 9007/2207027', api(9007, 2207027), 'transient'],
    ['API unknown (1)', api(1), 'transient'],
    ['API service (2)', api(2), 'transient'],
    ['HTTP 503 without code', api(null, null, 503), 'transient'],
    ['token expired (190)', api(190, 463, 400, 'OAuthException'), 'auth'],
    ['permission denied (10)', api(10), 'auth'],
    ['permission range (200)', api(200, null, 403), 'auth'],
    ['account restricted 25/2207050', api(25, 2207050), 'auth'],
    ['OAuthException without code', api(null, null, 400, 'OAuthException'), 'auth'],
    ['media not fetchable 9004/2207052', api(9004, 2207052), 'content'],
    ['too large 36000/2207004', api(36000, 2207004), 'content'],
    ['aspect ratio 36003/2207009', api(36003, 2207009), 'content'],
    ['duplicate post (506)', api(506), 'content'],
    // Subcode wins over code: code 4 alone is throttling, 4/2207051 is a spam restriction.
    ['spam restriction 4/2207051', api(4, 2207051), 'content'],
    ['undocumented code', api(123_456), 'unknown'],
  ])('%s -> %s', (_, error, expected) => {
    expect(classifyInstagramError(error)).toBe(expected);
  });

  it('no HTTP answer is transient; anything unexpected is unknown (never retried blindly)', () => {
    expect(classifyInstagramError(new GraphNetworkError('timeout'))).toBe('transient');
    expect(classifyInstagramError(new ZodError([]))).toBe('unknown');
    expect(classifyInstagramError(new Error('boom'))).toBe('unknown');
  });
});
