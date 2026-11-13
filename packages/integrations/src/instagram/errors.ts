// Error classification (CLAUDE.md section 5), from Meta's official tables only:
// - Instagram: https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/error-codes
// - Graph API: https://developers.facebook.com/docs/graph-api/guides/error-handling
// Anything not listed there is 'unknown' (never retried automatically).
import { ZodError } from 'zod';
import type { ErrorClass } from '../core/types.js';
import { GraphApiError, GraphNetworkError } from './graph-client.js';

/** Subcode-specific rules come first: the same code can mean different things (e.g. code 4). */
const BY_SUBCODE: Record<number, ErrorClass> = {
  2207042: 'quota', // "You reached maximum number of posts ... Content Publishing API."
  2207001: 'transient', // Instagram server error. Try again.
  2207003: 'transient', // "It takes too long to download the media."
  2207008: 'transient', // Media builder expired: retry, then create a new container.
  2207020: 'transient', // Media expired: create a new container and retry.
  2207027: 'transient', // "The media is not ready for publishing".
  2207032: 'transient', // "Create media fail, please try to re-create media".
  2207053: 'transient', // "unknown upload error": create a new container and retry.
  2207004: 'content', // Image larger than 8 MiB.
  2207005: 'content', // Unsupported image format.
  2207009: 'content', // Aspect ratio outside 4:5 .. 1.91:1.
  2207026: 'content', // Unsupported video format.
  2207052: 'content', // Media could not be fetched from the URI (must be public).
  2207057: 'content', // Invalid thumbnail offset.
  2207051: 'content', // Activity restricted (spam protection): the user must appeal.
  2207050: 'auth', // "The Instagram account is restricted.": the user must act in the app.
};

const BY_CODE: Record<number, ErrorClass> = {
  1: 'transient', // API Unknown: possibly temporary downtime.
  2: 'transient', // API Service: temporary downtime.
  4: 'quota', // API Too Many Calls.
  17: 'quota', // API User Too Many Calls.
  341: 'quota', // Application limit reached.
  368: 'quota', // Temporarily blocked for policy violations: wait and retry.
  10: 'auth', // Permission denied.
  102: 'auth', // API Session: get a new access token.
  190: 'auth', // Access token expired, revoked or invalid.
  506: 'content', // Duplicate post.
};

export function classifyInstagramError(error: unknown): ErrorClass {
  if (error instanceof GraphApiError) {
    if (error.subcode !== null && error.subcode in BY_SUBCODE)
      return BY_SUBCODE[error.subcode] ?? 'unknown';
    if (error.code !== null) {
      if (error.code in BY_CODE) return BY_CODE[error.code] ?? 'unknown';
      if (error.code >= 200 && error.code <= 299) return 'auth'; // API Permission
    }
    if (error.type === 'OAuthException') return 'auth';
    if (error.httpStatus >= 500) return 'transient';
    return 'unknown';
  }
  if (error instanceof GraphNetworkError) return 'transient';
  // The platform answered something we do not understand: do not guess.
  if (error instanceof ZodError) return 'unknown';
  return 'unknown';
}
