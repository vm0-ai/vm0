import {
  avatarSvgLayerUrls,
  isLegacyAvatarSvgConfig,
  type ResolvedAvatarSvgConfig,
} from "./avatar-svg-utils.ts";

interface AvatarSvgPreviewProps {
  config: ResolvedAvatarSvgConfig;
  size?: number;
  className?: string;
  alt?: string;
  "data-testid"?: string;
}

/**
 * Renders a composite avatar by layering head, face, and hair SVG images.
 */
export function AvatarSvgPreview({
  config,
  size,
  className,
  alt,
  "data-testid": testId,
}: AvatarSvgPreviewProps) {
  const urls = avatarSvgLayerUrls(config);
  const layerClassName = "absolute inset-0 h-full w-full object-cover";

  return (
    <div
      className={`relative overflow-hidden ${className ?? ""}`}
      style={size ? { width: size, height: size } : undefined}
      {...(alt ? { role: "img", "aria-label": alt } : undefined)}
      data-testid={testId}
    >
      <div
        className={`absolute inset-0 ${isLegacyAvatarSvgConfig(config) ? "scale-[1.25]" : ""}`}
      >
        {urls.map((src) => {
          return <img key={src} alt="" src={src} className={layerClassName} />;
        })}
      </div>
    </div>
  );
}
