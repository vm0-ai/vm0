import {
  type AvatarSvgConfig,
  headSvgUrl,
  hairSvgUrl,
  faceSvgUrl,
} from "./avatar-svg-utils.ts";

interface AvatarSvgPreviewProps {
  config: AvatarSvgConfig;
  size?: number;
  className?: string;
  alt?: string;
  "data-testid"?: string;
}

/**
 * Renders a composite avatar by stacking head, face, and hair SVG layers.
 */
export function AvatarSvgPreview({
  config,
  size,
  className,
  alt,
  "data-testid": testId,
}: AvatarSvgPreviewProps) {
  const layerClass = "absolute inset-0 h-full w-full object-cover";
  return (
    <div
      className={`relative overflow-hidden ${className ?? ""}`}
      style={size ? { width: size, height: size } : undefined}
      {...(alt ? { role: "img", "aria-label": alt } : undefined)}
      data-testid={testId}
    >
      <div className="absolute inset-0 scale-[1.25]">
        <img
          alt=""
          src={headSvgUrl(config.rotation, config.skin)}
          className={layerClass}
        />
        <img
          alt=""
          src={faceSvgUrl(config.rotation, config.expression, config.intensity)}
          className={layerClass}
        />
        <img
          alt=""
          src={hairSvgUrl(config.rotation, config.hairStyle, config.hairColor)}
          className={layerClass}
        />
      </div>
    </div>
  );
}
