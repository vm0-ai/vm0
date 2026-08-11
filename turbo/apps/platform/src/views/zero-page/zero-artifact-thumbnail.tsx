import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { cn } from "@vm0/ui";
import type { ImageLoadSignals } from "../../signals/image-load.ts";

type ArtifactThumbnailImageProps = {
  className: string;
  fallback: ReactNode;
  load: ImageLoadSignals;
  src: string;
  testId: string;
};

export function ArtifactThumbnailImage(props: ArtifactThumbnailImageProps) {
  return <ArtifactThumbnailImageInstance key={props.src} {...props} />;
}

function ArtifactThumbnailImageInstance({
  className,
  fallback,
  load,
  src,
  testId,
}: ArtifactThumbnailImageProps) {
  const failed = useGet(load.status$) === "error";
  const markLoaded = useSet(load.loaded$);
  const markFailed = useSet(load.failed$);

  return (
    <>
      {failed ? fallback : null}
      <img
        src={src}
        alt=""
        aria-hidden="true"
        data-testid={testId}
        loading="lazy"
        onLoad={markLoaded}
        onError={markFailed}
        className={cn(className, failed && "hidden")}
      />
    </>
  );
}
