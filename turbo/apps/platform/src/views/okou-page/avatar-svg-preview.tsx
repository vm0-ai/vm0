import {
  avatarSvgLayerUrls,
  type AvatarSvgConfig,
} from "./avatar-svg-utils.ts";

interface AvatarSvgPreviewProps {
  config: AvatarSvgConfig;
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
      <div className="absolute inset-0 scale-[1.25]">
        <img alt="" src={urls.head} className={layerClassName} />
        <img alt="" src={urls.face} className={layerClassName} />
        <img alt="" src={urls.hair} className={layerClassName} />
      </div>
    </div>
  );
}
