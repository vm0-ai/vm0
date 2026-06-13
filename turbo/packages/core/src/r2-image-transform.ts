const R2_IMAGE_TRANSFORM_HOSTS = new Set(["cdn.vm0.io", "cdn.vm7.io"]);
const R2_IMAGE_TRANSFORM_PREFIX = "/cdn-cgi/image/";

export interface R2ImageTransformOptions {
  readonly width?: number;
  readonly height?: number;
  readonly fit?: "scale-down";
}

function normalizedDimension(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.round(value);
}

function r2ImageTransformDirectives(
  options: R2ImageTransformOptions,
): string | null {
  const directives: string[] = [];
  const width = normalizedDimension(options.width);
  const height = normalizedDimension(options.height);

  if (width !== null) {
    directives.push(`width=${String(width)}`);
  }
  if (height !== null) {
    directives.push(`height=${String(height)}`);
  }
  directives.push(`fit=${options.fit ?? "scale-down"}`);

  return directives.length > 1 ? directives.join(",") : null;
}

function parseAbsoluteUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function r2ImageTransformUrl(
  url: string,
  options: R2ImageTransformOptions,
): string {
  const parsed = parseAbsoluteUrl(url);
  if (parsed === null) {
    return url;
  }

  if (
    !R2_IMAGE_TRANSFORM_HOSTS.has(parsed.hostname) ||
    parsed.pathname.startsWith(R2_IMAGE_TRANSFORM_PREFIX)
  ) {
    return url;
  }

  const directives = r2ImageTransformDirectives(options);
  if (directives === null) {
    return url;
  }

  return `${parsed.origin}${R2_IMAGE_TRANSFORM_PREFIX}${directives}${parsed.pathname}${parsed.search}${parsed.hash}`;
}
