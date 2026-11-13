// Instagram adapter (Instagram API with Unified Login, ADR 007): single image publishing.
// Flow documented in https://developers.facebook.com/documentation/instagram-platform/content-publishing
//   validate (no network) -> quota -> POST /{ig}/media -> GET /{container}?fields=status_code -> POST /{ig}/media_publish
import type { Secret } from '@ponctua/vault';
import { z, ZodError } from 'zod';
import { type InstagramCapabilities, instagramCapabilities } from '../capabilities/instagram.js';
import {
  type ErrorClass,
  type ImagePostVariant,
  type PlatformAdapter,
  type PublishingQuota,
  type PublishOutcome,
  RETRYABLE_ERROR_CLASSES,
  type ValidationIssue,
} from '../core/types.js';
import { classifyInstagramError } from './errors.js';
import {
  createGraphClient,
  type FetchLike,
  GraphApiError,
  GraphNetworkError,
  type GraphRequestFn,
} from './graph-client.js';

const idSchema = z.object({ id: z.string().min(1) });
const containerStatusSchema = z.object({
  id: z.string().optional(),
  status_code: z.enum(['EXPIRED', 'ERROR', 'FINISHED', 'IN_PROGRESS', 'PUBLISHED']),
  status: z.string().optional(),
});
const quotaSchema = z.object({
  data: z.array(
    z.object({
      quota_usage: z.number(),
      config: z.object({ quota_total: z.number(), quota_duration: z.number() }).optional(),
    }),
  ),
});

export interface InstagramAdapterOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Injected for tests; real code waits for real. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const PRIVATE_HOST =
  /^(localhost|.*\.local|.*\.internal|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i;

function describe(error: unknown): string {
  if (error instanceof GraphApiError) {
    return `code ${String(error.code)} subcode ${String(error.subcode)} (HTTP ${String(error.httpStatus)})`;
  }
  if (error instanceof GraphNetworkError) return 'no response from the platform';
  if (error instanceof ZodError) return 'unexpected response shape';
  return 'unexpected error';
}

function failed(
  errorClass: ErrorClass,
  containerId: string | null,
  detail: string,
): PublishOutcome {
  return {
    status: 'failed',
    errorClass,
    retryable: RETRYABLE_ERROR_CLASSES.includes(errorClass),
    containerId,
    detail,
  };
}

export function createInstagramAdapter(
  options: InstagramAdapterOptions = {},
): PlatformAdapter<InstagramCapabilities> {
  const graph: GraphRequestFn = createGraphClient({
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  const sleep = options.sleep ?? defaultSleep;
  const caps = instagramCapabilities;

  function validate(variant: ImagePostVariant, c: InstagramCapabilities): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!c.image.mimeTypes.value.includes(variant.mimeType)) {
      issues.push({ code: 'image.format', detail: 'Instagram publishes JPEG images only' });
    }

    let url: URL | null = null;
    try {
      url = new URL(variant.imageUrl);
    } catch {
      issues.push({ code: 'image.url_invalid', detail: 'image URL is not a valid URL' });
    }
    if (url && c.image.requiresPublicUrl.value) {
      if (url.protocol !== 'https:') {
        issues.push({ code: 'image.url_not_https', detail: 'image URL must use HTTPS' });
      }
      if (PRIVATE_HOST.test(url.hostname)) {
        issues.push({
          code: 'image.url_not_public',
          detail: 'Instagram downloads the image itself: the URL must be publicly reachable',
        });
      }
    }

    if (variant.sizeBytes !== undefined && variant.sizeBytes > c.image.maxBytes.value) {
      issues.push({ code: 'image.too_large', detail: 'image is larger than 8 MiB' });
    }
    if (variant.widthPx && variant.heightPx) {
      const ratio = variant.widthPx / variant.heightPx;
      const { min, max } = c.image.aspectRatio.value;
      if (ratio < min - 1e-9 || ratio > max + 1e-9) {
        issues.push({
          code: 'image.aspect_ratio',
          detail: 'aspect ratio must be between 4:5 and 1.91:1',
        });
      }
    }
    const maxCaption = c.captionMaxLength.value;
    if (maxCaption !== null && variant.caption.length > maxCaption) {
      issues.push({
        code: 'caption.too_long',
        detail: `caption exceeds ${String(maxCaption)} characters`,
      });
    }
    return issues;
  }

  async function publishingQuota(
    remoteAccountId: string,
    accessToken: Secret,
  ): Promise<PublishingQuota> {
    const response = await graph(
      {
        method: 'GET',
        path: `/${encodeURIComponent(remoteAccountId)}/content_publishing_limit`,
        params: { fields: 'quota_usage,config' },
        accessToken,
      },
      quotaSchema,
    );
    const entry = response.data[0];
    // Without a live config, assume the lowest documented limit rather than the highest.
    const fallbackTotal = Math.min(...caps.publishingLimit.value.documentedValues);
    return {
      used: entry?.quota_usage ?? 0,
      total: entry?.config?.quota_total ?? fallbackTotal,
      windowSeconds: entry?.config?.quota_duration ?? 86_400,
    };
  }

  async function containerStatus(containerId: string, accessToken: Secret) {
    return graph(
      {
        method: 'GET',
        path: `/${encodeURIComponent(containerId)}`,
        params: { fields: 'status_code' },
        accessToken,
      },
      containerStatusSchema,
    );
  }

  return {
    platform: 'instagram',
    capabilities: () => caps,
    validate,
    publishingQuota,
    classifyError: classifyInstagramError,

    async publish(job, hooks = {}) {
      const issues = validate(job.variant, caps);
      if (issues.length > 0) {
        return failed('content', null, `validation: ${issues.map((i) => i.code).join(', ')}`);
      }

      // 1. Quota first: never create a container that cannot be published.
      try {
        const quota = await publishingQuota(job.remoteAccountId, job.accessToken);
        if (quota.used >= quota.total) {
          return failed(
            'quota',
            null,
            `publishing quota reached (${String(quota.used)}/${String(quota.total)})`,
          );
        }
      } catch (error) {
        return failed(classifyInstagramError(error), null, `quota check: ${describe(error)}`);
      }

      // 2. Container. Failing here is safe: nothing is published, an orphan container expires in 24 h.
      let containerId: string;
      try {
        const container = await graph(
          {
            method: 'POST',
            path: `/${encodeURIComponent(job.remoteAccountId)}/media`,
            params: { image_url: job.variant.imageUrl, caption: job.variant.caption },
            accessToken: job.accessToken,
          },
          idSchema,
        );
        containerId = container.id;
      } catch (error) {
        return failed(
          classifyInstagramError(error),
          null,
          `container creation: ${describe(error)}`,
        );
      }
      await hooks.onContainerCreated?.(containerId);

      // 3. Wait until the container is ready (documented: once per minute, at most 5 minutes).
      const deadline = caps.container.statusPollMaxMs.value;
      for (let waited = 0; ; waited += caps.container.statusPollIntervalMs.value) {
        let status: z.infer<typeof containerStatusSchema>;
        try {
          status = await containerStatus(containerId, job.accessToken);
        } catch (error) {
          return failed(
            classifyInstagramError(error),
            containerId,
            `container status: ${describe(error)}`,
          );
        }
        if (status.status_code === 'FINISHED') break;
        if (status.status_code === 'PUBLISHED') {
          return { status: 'published', containerId, remoteMediaId: null };
        }
        if (status.status_code === 'EXPIRED') {
          return failed('transient', containerId, 'container expired before publishing');
        }
        if (status.status_code === 'ERROR') {
          return failed('unknown', containerId, 'container processing failed');
        }
        if (waited + caps.container.statusPollIntervalMs.value > deadline) {
          return failed('transient', containerId, 'container still in progress after 5 minutes');
        }
        await sleep(caps.container.statusPollIntervalMs.value);
      }

      // 4. Publish: the only call that makes the post public.
      try {
        const media = await graph(
          {
            method: 'POST',
            path: `/${encodeURIComponent(job.remoteAccountId)}/media_publish`,
            params: { creation_id: containerId },
            accessToken: job.accessToken,
          },
          idSchema,
        );
        return { status: 'published', containerId, remoteMediaId: media.id };
      } catch (error) {
        // The platform answered with an error: nothing was published.
        if (error instanceof GraphApiError) {
          return failed(classifyInstagramError(error), containerId, `publish: ${describe(error)}`);
        }
        // No answer, or a success answer we cannot read: it may have been published. Reconcile first.
        return { status: 'unknown_outcome', containerId };
      }
    },

    async reconcile(containerId, accessToken) {
      let status: z.infer<typeof containerStatusSchema>;
      try {
        status = await containerStatus(containerId, accessToken);
      } catch (error) {
        if (error instanceof GraphApiError) {
          return failed(
            classifyInstagramError(error),
            containerId,
            `reconcile: ${describe(error)}`,
          );
        }
        return null; // Still unknown: try again later.
      }
      switch (status.status_code) {
        case 'PUBLISHED':
          return { status: 'published', containerId, remoteMediaId: null };
        case 'FINISHED':
          // Ready but never published: a new attempt may publish this very container.
          return failed('transient', containerId, 'container ready but not published');
        case 'EXPIRED':
          return failed('transient', containerId, 'container expired, never published');
        case 'ERROR':
          return failed('unknown', containerId, 'container processing failed');
        case 'IN_PROGRESS':
          return null;
      }
    },
  };
}
