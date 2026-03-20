import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";
import { cn } from "@vm0/ui";

const CONNECTOR_ICONS: Readonly<Record<ConnectorType, string>> = Object.freeze(
  (() => {
    const allIcons = Object.fromEntries(
      Object.entries(
        import.meta.glob<string>("./icons/*.svg", {
          eager: true,
          import: "default",
        }),
      ).map(([path, url]) => [
        path.replace("./icons/", "").replace(".svg", ""),
        url,
      ]),
    );

    const connectorKeys = Object.keys(CONNECTOR_TYPES) as ConnectorType[];
    const filtered: Record<string, string> = {};
    for (const key of connectorKeys) {
      const icon = allIcons[key];
      if (typeof icon !== "string") {
        throw new Error(
          `Missing SVG icon for connector type "${key}". Add icons/${key}.svg.`,
        );
      }
      filtered[key] = icon;
    }

    return filtered as Record<ConnectorType, string>;
  })(),
);

const MONOCHROME_ICONS: Readonly<Record<string, true>> = Object.freeze({
  agentmail: true,
  "bright-data": true,
  cronlytic: true,
  discord: true,
  "discord-webhook": true,
  dify: true,
  github: true,
  htmlcsstoimage: true,
  hume: true,
  instagram: true,
  notion: true,
  openai: true,
  pdforge: true,
  wix: true,
  v0: true,
  x: true,
});

export function ConnectorIcon({
  type,
  size = 28,
}: {
  type: ConnectorType;
  size?: number;
}) {
  const icon = CONNECTOR_ICONS[type];
  return (
    <img
      src={icon}
      width={size}
      height={size}
      alt=""
      className={cn("shrink-0", type in MONOCHROME_ICONS && "zero-icon-mono")}
    />
  );
}
