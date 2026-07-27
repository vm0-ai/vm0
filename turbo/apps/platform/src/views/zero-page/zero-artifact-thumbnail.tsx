import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { cn } from "@vm0/ui";
import {
  imageLoadStatusByKey$,
  imageLoadStatusRef$,
  setImageLoadStatus$,
} from "../../signals/view-component-state.ts";

type ArtifactThumbnailImageProps = {
  className: string;
  fallback: ReactNode;
  src: string;
  testId: string;
};

export function ArtifactThumbnailImage(props: ArtifactThumbnailImageProps) {
  return <ArtifactThumbnailImageInstance key={props.src} {...props} />;
}

function ArtifactThumbnailImageInstance({
  className,
  fallback,
  src,
  testId,
}: ArtifactThumbnailImageProps) {
  const imageLoadKey = `artifact-thumbnail:${testId}:${src}`;
  const imageLoadStatuses = useGet(imageLoadStatusByKey$, {
    equalityFn: (previous, next) => {
      return previous[imageLoadKey] === next[imageLoadKey];
    },
  });
  const imageLoadStatusRef = useSet(imageLoadStatusRef$);
  const setImageLoadStatus = useSet(setImageLoadStatus$);
  const failed = imageLoadStatuses[imageLoadKey] === "error";

  return (
    <>
      {failed ? fallback : null}
      <img
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
