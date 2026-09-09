import { Plus, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ROUTES } from "../../../../signals/route-paths.ts";
import { Link } from "../../../router/link.tsx";
import { ConnectorEntryCard } from "./connector-entry-card.tsx";

export function SshConnectorCard({
  configuredCount,
}: {
  readonly configuredCount: number;
}) {
  const { t } = useTranslation();
  return (
    <ConnectorEntryCard
      icon={<Terminal size={20} aria-hidden="true" />}
      label={t(($) => {
        return $.ssh.label;
      })}
      description={t(($) => {
        return $.ssh.description;
      })}
      showDescription={configuredCount === 0}
      interactive
      action={
        <Link
          pathname={ROUTES.settingsSsh}
          aria-label={t(($) => {
            return $.ssh.manage;
          })}
          className="absolute inset-0 z-10 cursor-pointer rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
      }
      indicator={
        configuredCount === 0 ? (
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/60 text-muted-foreground"
            aria-hidden="true"
          >
            <Plus size={14} />
          </span>
        ) : null
      }
      status={
        <span className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50"
            aria-hidden="true"
          />
          <span className="truncate">
            {t(
              ($) => {
                return $.ssh.summary;
              },
              { count: configuredCount },
            )}
          </span>
        </span>
      }
    />
  );
}
