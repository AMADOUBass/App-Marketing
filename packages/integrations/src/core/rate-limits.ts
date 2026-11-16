import { instagramCapabilities } from '../capabilities/instagram.js';
import type { PlatformId } from './types.js';

/**
 * One token bucket (ADR 013): at most `capacity` publications per `windowSeconds`, refilled
 * continuously. `app` is shared by every account of the platform; `account` is per social account.
 */
export interface RateLimitRule {
  scope: 'app' | 'account';
  capacity: number;
  windowSeconds: number;
}

/** From the capability registry (rule 7): platforms without documented limits get none here. */
export function rateLimitRules(platform: PlatformId): readonly RateLimitRule[] {
  switch (platform) {
    case 'instagram':
      return instagramCapabilities.rateLimits.value;
    case 'facebook':
    case 'threads':
    case 'youtube':
    case 'linkedin':
    case 'tiktok':
      return [];
  }
}
