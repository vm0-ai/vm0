import {
  createDeferredPromise,
  withCleanup,
} from "../../../../signals/utils.ts";

export function readImageDimensions(
  file: File,
  signal: AbortSignal,
): Promise<{ width: number; height: number } | null> {
  signal.throwIfAborted();
  const url = URL.createObjectURL(file);
  const img = new Image();
  const dimensions = createDeferredPromise<{
    width: number;
    height: number;
  } | null>(signal);
  const onLoad = () => {
    dimensions.resolve({ width: img.naturalWidth, height: img.naturalHeight });
  };
  const onError = () => {
    dimensions.resolve(null);
  };
  img.addEventListener("load", onLoad, { once: true, signal });
  img.addEventListener("error", onError, { once: true, signal });
  img.src = url;
  return withCleanup(dimensions.promise, () => {
    img.removeEventListener("load", onLoad);
    img.removeEventListener("error", onError);
    img.removeAttribute("src");
    URL.revokeObjectURL(url);
  });
}
