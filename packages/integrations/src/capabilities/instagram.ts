// Capability registry for Instagram (rule 7: platform limits are data, with their source, never constants
// buried in code). Every value below was read in Meta's official documentation on the date shown.
import type { Sourced } from '../core/types.js';

const VERIFIED_ON = '2026-11-13';
const DOCS = 'https://developers.facebook.com/documentation/instagram-platform';

const fact = <T>(value: T, source: string): Sourced<T> => ({
  value,
  source: `${DOCS}/${source}`,
  verifiedOn: VERIFIED_ON,
});

export const instagramCapabilities = {
  /** Instagram API with Unified Login (recommended for new integrations, ADR 007). */
  graphHost: fact('https://graph.facebook.com', 'instagram-api-with-unified-login'),
  graphApiVersion: fact('v27.0', 'instagram-api-with-unified-login/authentication'),
  loginDialogHost: fact(
    'https://www.facebook.com',
    // To confirm on the real account (9c): the authentication page does not detail the dialog URL.
    'instagram-api-with-unified-login/authentication',
  ),
  image: {
    mimeTypes: fact(['image/jpeg'], 'content-publishing'),
    /** Error 36000 / 2207004: "The image exceeds the 8 MiB limit." */
    maxBytes: fact(8 * 1024 * 1024, 'instagram-graph-api/reference/error-codes'),
    /** Error 36003 / 2207009: aspect ratio between 4:5 and 1.91:1. */
    aspectRatio: fact({ min: 4 / 5, max: 1.91 }, 'instagram-graph-api/reference/error-codes'),
    /** "We cURL your image using the passed in URL so it must be on a public server." */
    requiresPublicUrl: fact(true, 'content-publishing'),
  },
  /** The publishing page does not state a caption limit: none is enforced here until it is documented. */
  captionMaxLength: fact<number | null>(null, 'content-publishing'),
  container: {
    /** "The container was not published within 24 hours and has expired." */
    ttlSeconds: fact(24 * 60 * 60, 'instagram-graph-api/reference/ig-container'),
    /** "We recommend querying a container's status once per minute, for no more than 5 minutes." */
    statusPollIntervalMs: fact(60_000, 'content-publishing'),
    statusPollMaxMs: fact(5 * 60_000, 'content-publishing'),
  },
  /**
   * The docs disagree (content-publishing says 100 posts / 24 h, the reference says quota_total is
   * "currently 50"). The live value from content_publishing_limit is always used instead.
   */
  publishingLimit: fact(
    { documentedValues: [50, 100], useLiveValue: true },
    'instagram-graph-api/reference/ig-user/content_publishing_limit',
  ),
  /** Least privilege: no ads permissions (ads management is out of scope, CLAUDE.md section 1). */
  permissions: fact(
    ['instagram_basic', 'instagram_content_publish'],
    'instagram-api-with-unified-login/permissions',
  ),
} as const;

export type InstagramCapabilities = typeof instagramCapabilities;
