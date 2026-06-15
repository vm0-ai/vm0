import { useLastResolved } from "ccstate-react";
import type { AvatarSvgConfig } from "./avatar-svg-utils.ts";
import { compositeAvatarSvg$ } from "../../signals/zero-page/avatar-svg-cache.ts";

interface AvatarSvgPreviewProps {
  config: AvatarSvgConfig;
  size?: number;
  className?: string;
  alt?: string;
  "data-testid"?: string;
}

/**
 * Renders a composite avatar by lazily loading head, face, and hair SVG layers
 * and displaying the combined result as a single `<img>` with a data-URL src.
 */
export function AvatarSvgPreview({
  config,
  size,
  className,
  alt,
  "data-testid": testId,
}: AvatarSvgPreviewProps) {
  const dataUrl = useLastResolved(compositeAvatarSvg$(config));

  return (
    <div
      className={`relative overflow-hidden ${className ?? ""}`}
      style={size ? { width: size, height: size } : undefined}
      {...(alt ? { role: "img", "aria-label": alt } : undefined)}
      data-testid={testId}
    >
      {dataUrl !== undefined && (
        <div className="absolute inset-0 scale-[1.25]">
          <img alt="" src={dataUrl} className="h-full w-full object-cover" />
        </div>
      )}
    </div>
  );
}
