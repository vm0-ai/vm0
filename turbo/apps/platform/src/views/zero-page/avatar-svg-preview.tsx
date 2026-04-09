import {
  type AvatarSvgConfig,
  headSvgUrl,
  hairSvgUrl,
  faceSvgUrl,
} from "./avatar-svg-utils.ts";

interface AvatarSvgPreviewProps {
  config: AvatarSvgConfig;
  size: number;
  className?: string;
}

/**
 * Renders a composite avatar by stacking head, face, and hair SVG layers.
 */
export function AvatarSvgPreview({
  config,
  size,
  className,
}: AvatarSvgPreviewProps) {
  const layerClass = "absolute inset-0 h-full w-full";
  return (
    <div
      className={`relative overflow-hidden rounded-full ${className ?? ""}`}
      style={{ width: size, height: size }}
    >
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
  );
}
