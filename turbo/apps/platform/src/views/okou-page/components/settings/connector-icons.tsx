import { Plug } from "lucide-react";
import type { PublicConnectorCatalogIcon } from "@okouai/api-contracts/contracts/connector-catalog";
import { cn } from "@okouai/ui";
import { useTranslation } from "react-i18next";

function ConnectorIconFallback({
  size,
  hidden = false,
}: {
  size: number;
  hidden?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <span
      hidden={hidden}
      role="img"
      aria-label={t(($) => {
        return $.connectors.catalog.iconUnavailable;
      })}
      className="inline-flex h-full w-full items-center justify-center text-muted-foreground"
    >
      <Plug size={size * 0.65} aria-hidden="true" />
    </span>
  );
}

/** Connector mark in a square slot, driven by public catalog display data. */
export function ConnectorIcon({
  icon,
  size = 28,
}: {
  icon: PublicConnectorCatalogIcon | undefined;
  size?: number;
}) {
  const scaled = icon?.scale !== undefined;

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        scaled && "overflow-hidden",
      )}
      style={{ width: size, height: size }}
    >
      {icon === undefined ? (
        <ConnectorIconFallback size={size} />
      ) : (
        <span
          key={icon.url}
          className="inline-flex h-full w-full items-center justify-center"
        >
          <img
            src={icon.url}
            alt=""
            decoding="async"
            className={cn(
              "block h-full w-full max-h-full max-w-full object-contain",
              icon.invertInDarkMode && "okou-icon-mono",
            )}
            style={
              icon.scale === undefined
                ? undefined
                : { transform: `scale(${icon.scale})` }
            }
            onError={(event) => {
              event.currentTarget.hidden = true;
              event.currentTarget.nextElementSibling?.removeAttribute("hidden");
            }}
          />
          <ConnectorIconFallback size={size} hidden />
        </span>
      )}
    </span>
  );
}
