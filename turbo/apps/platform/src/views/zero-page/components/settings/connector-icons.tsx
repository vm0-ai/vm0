import type { ConnectorType } from "@vm0/connectors/connectors";
import {
  getStaticConnectorIconMetadata,
  isStaticConnectorIconType,
} from "@vm0/connectors/static-connector-icons";
import { cn } from "@vm0/ui";

export function isConnectorIconType(type: string): type is ConnectorType {
  return isStaticConnectorIconType(type);
}

/**
 * Connector mark in a square slot. The asset scales with `object-contain` so the
 * drawable uses the full `size×size` box (e.g. a 20×28 logo fills height in a 28×28 slot).
 */
export function ConnectorIcon({
  type,
  size = 28,
}: {
  type: ConnectorType;
  size?: number;
}) {
  const icon = getStaticConnectorIconMetadata(type);
  const scaled = icon.scale !== undefined;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        scaled && "overflow-hidden",
      )}
      style={{ width: size, height: size }}
    >
      <img
        src={icon.url}
        alt=""
        decoding="async"
        className={cn(
          "block h-full w-full max-h-full max-w-full object-contain",
          icon.invertInDarkMode && "zero-icon-mono",
          scaled && "scale-[2.2]",
        )}
      />
    </span>
  );
}
