// DOCS-DERIVED FIXTURES: shapes and values copied from Meta's official documentation examples (2026-11-13).
// They are NOT recorded from a real account yet: replace them with recorded responses in 9c (CLAUDE.md
// section 7, contract tests on recorded fixtures). Ids are the documentation's sample ids.
const DOCS = 'https://developers.facebook.com/documentation/instagram-platform';

export const SOURCES = {
  quota: `${DOCS}/instagram-graph-api/reference/ig-user/content_publishing_limit`,
  container: `${DOCS}/instagram-graph-api/reference/ig-container`,
  publishing: `${DOCS}/content-publishing`,
  errors: `${DOCS}/instagram-graph-api/reference/error-codes`,
  graphErrors: 'https://developers.facebook.com/docs/graph-api/guides/error-handling',
} as const;

export const IG_USER_ID = '17841472428926955';
export const CONTAINER_ID = '17889615691921648';
export const MEDIA_ID = '17920238422030506';

export const quota = (used: number, total = 50) => ({
  data: [{ quota_usage: used, config: { quota_total: total, quota_duration: 86400 } }],
});

export const containerCreated = { id: CONTAINER_ID };
export const containerStatus = (statusCode: string) => ({
  status_code: statusCode,
  id: CONTAINER_ID,
});
export const published = { id: MEDIA_ID };

const graphError = (
  code: number,
  subcode: number | undefined,
  message: string,
  type = 'OAuthException',
) => ({
  error: {
    message,
    type,
    code,
    ...(subcode === undefined ? {} : { error_subcode: subcode }),
    fbtrace_id: 'EJplcsCHuLu',
  },
});

export const errors = {
  quotaReached: graphError(
    9,
    2207042,
    'You reached maximum number of posts that is allowed to be published by Content Publishing API.',
  ),
  mediaNotFetchable: graphError(
    9004,
    2207052,
    'The media could not be fetched from this uri: https://media.example.com/a.jpg?X-Amz-Signature=secret-signature',
  ),
  notReady: graphError(
    9007,
    2207027,
    'The media is not ready for publishing, please wait for a moment',
  ),
  serverError: graphError(-1, 2207001, 'Instagram server error'),
  tokenExpired: graphError(190, 463, 'Error validating access token'),
  permissionDenied: graphError(10, undefined, 'Permission denied'),
  tooManyCalls: graphError(4, undefined, 'Application request limit reached'),
  spamRestricted: graphError(4, 2207051, 'We restrict certain activity to protect our community.'),
  aspectRatio: graphError(
    36003,
    2207009,
    'The submitted image with aspect ratio 0.33 cannot be published. Please submit an image with a valid aspect ratio.',
  ),
};
