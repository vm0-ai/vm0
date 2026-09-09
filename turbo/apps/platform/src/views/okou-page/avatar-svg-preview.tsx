import { useGet } from "ccstate-react";
import {
  avatarFramingEnabled$,
  avatarNeckSweaterEnabled$,
} from "../../signals/external/feature-switch.ts";
import {
  AVATAR_ARTWORK_SLOT,
  AVATAR_HEAD_SLOT,
  avatarSvgComposition,
  avatarSvgContentTransform,
  type ResolvedAvatarSvgConfig,
} from "./avatar-svg-utils.ts";

interface AvatarSvgPreviewProps {
  config: ResolvedAvatarSvgConfig;
  size?: number;
  className?: string;
  centerContent?: boolean;
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
  centerContent = false,
  alt,
  "data-testid": testId,
}: AvatarSvgPreviewProps) {
  const neckSweater = useGet(avatarNeckSweaterEnabled$);
  const framing = useGet(avatarFramingEnabled$);
  const { behind, head, front, headOffsetY, contentOffsetY, contentScale } =
    avatarSvgComposition(config, { neckSweater, framing });
  // `centerContent` is the avatar maker asking for centering on its own while
  // the framing switch is off; the rule centers every avatar once it ships, and
  // the prop goes with the switch.
  const transform = avatarSvgContentTransform({
    contentOffsetY: framing || centerContent ? contentOffsetY : 0,
    contentScale,
  });
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
        {...AVATAR_ARTWORK_SLOT}
        className="absolute inset-0"
        style={transform ? { transform } : undefined}
      >
        {behind.map(layer)}
        <div
          {...AVATAR_HEAD_SLOT}
          className="absolute inset-0"
          style={{
            transform: `translateY(${headOffsetY}%)`,
          }}
        >
          {head.map(layer)}
        </div>
        {front.map(layer)}
      </div>
    </div>
  );
}
