// View-level helper that wraps a one-shot `<img>` load/error event pair into
// a Promise. This file is exempted from `ccstate/no-new-promise` in
// eslint.config.js because there is no ambient AbortSignal at this call site
// (the DOM image load cannot be cancelled) and the resolver is guaranteed to
// fire exactly once.
export function readImageDimensions(
  file: File,
): Promise<{ width: number; height: number } | null> {
  const url = URL.createObjectURL(file);
  return new Promise((resolve) => {
    const img = new Image();
    img.addEventListener("load", () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    });
    img.addEventListener("error", () => {
      URL.revokeObjectURL(url);
      resolve(null);
    });
    img.src = url;
  });
}
