import {
  type AvatarSvgConfig,
  compositeAvatarSvgInner,
} from "./avatar-svg-utils.ts";

interface AvatarSvgPreviewProps {
  config: AvatarSvgConfig;
  size?: number;
  className?: string;
  alt?: string;
  "data-testid"?: string;
}

/**
 * Renders a composite avatar by stacking head, face, and hair SVG layers
 * into a single inline `<svg>` element (zero network requests).
 */
export function AvatarSvgPreview({
  config,
  size,
  className,
  alt,
  "data-testid": testId,
}: AvatarSvgPreviewProps) {
  return (
    <div
      className={`relative overflow-hidden ${className ?? ""}`}
      style={size ? { width: size, height: size } : undefined}
      {...(alt ? { role: "img", "aria-label": alt } : undefined)}
      data-testid={testId}
    >
      <div className="absolute inset-0 scale-[1.25]">
        <svg
          viewBox="0 0 480 480"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="h-full w-full"
          dangerouslySetInnerHTML={{ __html: compositeAvatarSvgInner(config) }}
        />
      </div>
    </div>
  );
}
