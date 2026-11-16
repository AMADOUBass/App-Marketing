// Checks a post can be scheduled on a platform, before anything is queued (pure, no network).
// What needs the file itself (format, size, aspect ratio) is checked again by the adapter at publish
// time, once the media facts are known.
import { instagramCapabilities } from '../capabilities/instagram.js';
import { PRIVATE_HOST } from '../instagram/adapter.js';
import type { PlatformId, ValidationIssue } from './types.js';

export interface PostDraft {
  text: string;
  /** Phase 0 media (ADR 007): one public image URL, until the media library exists. */
  imageUrl: string | null;
}

/** Platforms that have a publishing adapter today; the others cannot be scheduled yet. */
export const PUBLISHABLE_PLATFORMS: readonly PlatformId[] = ['instagram'];

function checkPublicImageUrl(imageUrl: string, platformName: string): ValidationIssue[] {
  let url: URL;
  try {
    url = new URL(imageUrl);
  } catch {
    return [{ code: 'image.url_invalid', detail: 'image URL is not a valid URL' }];
  }
  const issues: ValidationIssue[] = [];
  if (url.protocol !== 'https:') {
    issues.push({ code: 'image.url_not_https', detail: 'image URL must use HTTPS' });
  }
  if (PRIVATE_HOST.test(url.hostname)) {
    issues.push({
      code: 'image.url_not_public',
      detail: `${platformName} downloads the image itself: the URL must be publicly reachable`,
    });
  }
  return issues;
}

export function checkDraftForPlatform(platform: PlatformId, draft: PostDraft): ValidationIssue[] {
  switch (platform) {
    case 'instagram': {
      if (!draft.imageUrl) {
        // Content publishing always creates a media container (image, video, carousel): no text-only post.
        return [{ code: 'media.required', detail: 'Instagram posts need an image' }];
      }
      const issues = checkPublicImageUrl(draft.imageUrl, 'Instagram');
      const maxCaption = instagramCapabilities.captionMaxLength.value;
      if (maxCaption !== null && draft.text.length > maxCaption) {
        issues.push({
          code: 'caption.too_long',
          detail: `caption exceeds ${String(maxCaption)} characters`,
        });
      }
      return issues;
    }
    // Adapters to come (MVP order: Facebook and Threads next).
    case 'facebook':
    case 'threads':
    case 'youtube':
    case 'linkedin':
    case 'tiktok':
      return [
        { code: 'platform.unavailable', detail: `publishing to ${platform} is not available yet` },
      ];
  }
}
