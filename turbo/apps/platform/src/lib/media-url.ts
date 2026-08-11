/** URL shape predicates shared by markdown rendering and tree preparation. */

export function isImageUrl(href: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif)(?:\?|#|$)/i.test(href);
}

export function isVideoUrl(href: string): boolean {
  return /\.(mp4|webm|mov|ogv)(?:\?|#|$)/i.test(href);
}

/**
 * Only `http:` / `https:` URLs are safe to render as `<img src>` or `<video src>`.
 * Blocks `javascript:`, `data:`, `file:`, etc. in assistant-rendered markdown.
 */
export function isSafeMediaUrl(href: string): boolean {
  return /^https?:\/\//i.test(href);
}
