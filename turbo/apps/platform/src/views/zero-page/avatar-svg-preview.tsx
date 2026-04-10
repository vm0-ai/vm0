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
 * Renders a composite avatar by lazily loading head, face, and hair SVG chunks
 * and stacking them into a single inline `<svg>` element.
 */
export function AvatarSvgPreview({
  config,
  size,
  className,
  alt,
  "data-testid": testId,
}: AvatarSvgPreviewProps) {
  const inner = useLastResolved(compositeAvatarSvg$(config));

  return (
    <div
      className={`relative overflow-hidden ${className ?? ""}`}
      style={size ? { width: size, height: size } : undefined}
      {...(alt ? { role: "img", "aria-label": alt } : undefined)}
      data-testid={testId}
    >
      {inner !== undefined && (
        <div className="absolute inset-0 scale-[1.25]">
          <svg
            viewBox="0 0 480 480"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="h-full w-full"
            dangerouslySetInnerHTML={{ __html: inner }}
          />
        </div>
      )}
    </div>
  );
}
