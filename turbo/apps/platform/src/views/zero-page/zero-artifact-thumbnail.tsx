import { useState, type ReactNode } from "react";
import { cn } from "@vm0/ui";

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
  const [failed, setFailed] = useState(false);

  return (
    <>
      {failed ? fallback : null}
      <img
        src={src}
        alt=""
        aria-hidden="true"
        data-testid={testId}
        loading="lazy"
        onLoad={() => {
          setFailed(false);
        }}
        onError={() => {
          setFailed(true);
        }}
        className={cn(className, failed && "hidden")}
      />
    </>
  );
}
