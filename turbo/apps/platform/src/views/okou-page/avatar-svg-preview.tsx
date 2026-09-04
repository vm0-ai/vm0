import {
  AVATAR_HEAD_TRANSFORM_ORIGIN,
  avatarSvgComposition,
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
 * Renders a composite avatar by layering neck, head, and sweater SVG images.
 */
export function AvatarSvgPreview({
  config,
  size,
  className,
  alt,
  "data-testid": testId,
}: AvatarSvgPreviewProps) {
  const { behind, head, front, headScale } = avatarSvgComposition(config);
  const layerClassName = "absolute inset-0 h-full w-full object-cover";
  const layer = (src: string) => {
    return <img key={src} alt="" src={src} className={layerClassName} />;
  };

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
        {behind.map(layer)}
        <div
          className="absolute inset-0"
          style={{
            transform: `scale(${headScale})`,
            transformOrigin: AVATAR_HEAD_TRANSFORM_ORIGIN,
          }}
        >
          {head.map(layer)}
        </div>
        {front.map(layer)}
      </div>
    </div>
  );
}
