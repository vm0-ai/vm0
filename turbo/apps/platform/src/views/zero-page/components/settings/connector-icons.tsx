import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";
import { cn } from "@vm0/ui";

const iconModules = import.meta.glob<string>("./icons/*.svg", {
  eager: true,
  import: "default",
});

const iconEntries = Object.entries(iconModules).map(([path, url]) => {
  const name = path.replace("./icons/", "").replace(".svg", "");
  return [name, url] as const;
});

const iconMap = Object.fromEntries(iconEntries) as Record<
  ConnectorType,
  string
>;

// Validate at dev time that every connector type has a matching icon file
if (import.meta.env.DEV) {
  const missingIcons = Object.keys(CONNECTOR_TYPES).filter(
    (type) => !(type in iconMap),
  );
  if (missingIcons.length > 0) {
    console.error(
      `Missing connector icons for: ${missingIcons.join(", ")}. ` +
        `Add SVG files to the icons/ directory with matching names.`,
    );
  }
}

const CONNECTOR_ICONS: Readonly<Record<ConnectorType, string>> =
  Object.freeze(iconMap);

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
