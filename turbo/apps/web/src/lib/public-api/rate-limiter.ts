/**
 * Public API v1 Rate Limiting
 *
 * Simple in-memory rate limiter with sliding window algorithm.
 * For production scale, this should be replaced with Redis-based rate limiting.
 */
import type { RateLimitInfo } from "@vm0/core";

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  /** Maximum requests per window */
  limit: number;
  /** Window size in seconds */
  windowSeconds: number;
}

/**
 * Default rate limit: 1000 requests per hour
 */
export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  limit: 1000,
  windowSeconds: 3600,
};

/**
 * Higher limit for read operations: 5000 requests per hour
 */
export const READ_RATE_LIMIT: RateLimitConfig = {
  limit: 5000,
  windowSeconds: 3600,
};

/**
 * Lower limit for write operations: 500 requests per hour
 */
export const WRITE_RATE_LIMIT: RateLimitConfig = {
  limit: 500,
  windowSeconds: 3600,
};

/**
 * Rate limit bucket entry
 */
interface RateLimitBucket {
  count: number;
  windowStart: number;
}

/**
 * In-memory rate limit storage
 * Key format: `${userId}:${endpoint}`
 */
const rateLimitBuckets = new Map<string, RateLimitBucket>();

/**
 * Cleanup interval for expired buckets (5 minutes)
 */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Start periodic cleanup of expired rate limit buckets
 */
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startCleanup() {
  if (cleanupTimer) return;

  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of rateLimitBuckets.entries()) {
      // Remove buckets older than 2x the longest window (2 hours)
      if (now - bucket.windowStart > 2 * 3600 * 1000) {
        rateLimitBuckets.delete(key);
      }
    }
  }, CLEANUP_INTERVAL_MS);

  // Prevent timer from keeping process alive
  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }
}

// Start cleanup on module load
startCleanup();

/**
 * Check and update rate limit for a user/endpoint combination
 *
 * @param userId - User ID or API token ID
 * @param endpoint - Endpoint identifier (e.g., "POST /v1/runs")
 * @param config - Rate limit configuration
 * @returns Rate limit info with remaining requests, or null if limit exceeded
 */
export function checkRateLimit(
  userId: string,
  endpoint: string,
  config: RateLimitConfig = DEFAULT_RATE_LIMIT,
): RateLimitInfo | null {
  const key = `${userId}:${endpoint}`;
  const now = Date.now();
  const windowStart =
    Math.floor(now / (config.windowSeconds * 1000)) *
    (config.windowSeconds * 1000);

  let bucket = rateLimitBuckets.get(key);

  // Reset bucket if in new window
  if (!bucket || bucket.windowStart < windowStart) {
    bucket = { count: 0, windowStart };
    rateLimitBuckets.set(key, bucket);
  }

  // Calculate remaining
  const remaining = Math.max(0, config.limit - bucket.count);
  const reset = Math.floor((windowStart + config.windowSeconds * 1000) / 1000);

  // Check if limit exceeded
  if (remaining === 0) {
    return null; // Limit exceeded
  }

  // Increment counter
  bucket.count++;
  rateLimitBuckets.set(key, bucket);

  return {
    limit: config.limit,
    remaining: remaining - 1, // After this request
    reset,
  };
}

/**
 * Get current rate limit info without incrementing
 */
export function getRateLimitInfo(
  userId: string,
  endpoint: string,
  config: RateLimitConfig = DEFAULT_RATE_LIMIT,
): RateLimitInfo {
  const key = `${userId}:${endpoint}`;
  const now = Date.now();
  const windowStart =
    Math.floor(now / (config.windowSeconds * 1000)) *
    (config.windowSeconds * 1000);

  const bucket = rateLimitBuckets.get(key);

  // If no bucket or bucket is from old window, full limit available
  if (!bucket || bucket.windowStart < windowStart) {
    return {
      limit: config.limit,
      remaining: config.limit,
      reset: Math.floor((windowStart + config.windowSeconds * 1000) / 1000),
    };
  }

  return {
    limit: config.limit,
    remaining: Math.max(0, config.limit - bucket.count),
    reset: Math.floor(
      (bucket.windowStart + config.windowSeconds * 1000) / 1000,
    ),
  };
}

/**
 * Rate limit header names
 */
export const RATE_LIMIT_HEADERS = {
  LIMIT: "X-RateLimit-Limit",
  REMAINING: "X-RateLimit-Remaining",
  RESET: "X-RateLimit-Reset",
  RETRY_AFTER: "Retry-After",
} as const;

/**
 * Add rate limit headers to response
 */
export function setRateLimitHeaders(
  headers: Headers,
  info: RateLimitInfo,
): void {
  headers.set(RATE_LIMIT_HEADERS.LIMIT, String(info.limit));
  headers.set(RATE_LIMIT_HEADERS.REMAINING, String(info.remaining));
  headers.set(RATE_LIMIT_HEADERS.RESET, String(info.reset));
}

/**
 * Reset rate limit for testing
 */
export function resetRateLimits(): void {
  rateLimitBuckets.clear();
}
