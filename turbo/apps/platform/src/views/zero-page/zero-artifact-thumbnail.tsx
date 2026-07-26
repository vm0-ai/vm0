import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { cn } from "@vm0/ui";
import {
  imageLoadStatusByKey$,
  imageLoadStatusRef$,
  setImageLoadStatus$,
} from "../../signals/view-component-state.ts";

export function ArtifactThumbnailImage({
  className,
  fallback,
  src,
  testId,
}: {
  className: string;
  fallback: ReactNode;
  src: string;
  testId: string;
}) {
  const imageLoadStatuses = useGet(imageLoadStatusByKey$);
  const imageLoadStatusRef = useSet(imageLoadStatusRef$);
  const setImageLoadStatus = useSet(setImageLoadStatus$);
  const imageLoadKey = `artifact-thumbnail:${src}`;
  const imageStatus = imageLoadStatuses[imageLoadKey] ?? "loading";
  const failed = imageStatus === "error";

  return (
    <>
      {failed ? fallback : null}
      <img
        key={imageLoadKey}
        ref={imageLoadStatusRef}
        src={src}
        alt=""
        aria-hidden="true"
        data-image-load-key={imageLoadKey}
        data-testid={testId}
        loading="lazy"
        onLoad={() => {
          setImageLoadStatus(imageLoadKey, "loaded");
        }}
        onError={() => {
          setImageLoadStatus(imageLoadKey, "error");
        }}
        className={cn(className, failed && "hidden")}
      />
    </>
  );
}
