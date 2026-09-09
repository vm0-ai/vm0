import { Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ROUTES } from "../../../../signals/route-paths.ts";
import { Link } from "../../../router/link.tsx";

export function SshConnectorCard({
  configuredCount,
}: {
  readonly configuredCount: number;
}) {
  const { t } = useTranslation();
  return (
    <Link
      pathname={ROUTES.settingsSsh}
      aria-label={t(($) => {
        return $.ssh.manage;
      })}
      className="flex flex-col rounded-2xl border bg-card text-card-foreground transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-center gap-2.5 px-5 pt-4">
        <Terminal className="size-5 shrink-0" aria-hidden="true" />
        <span className="font-medium">
          {t(($) => {
            return $.ssh.label;
          })}
        </span>
      </div>
      <p className="line-clamp-2 px-5 pb-4 pt-2 text-sm text-muted-foreground">
        {t(($) => {
          return $.ssh.description;
        })}
      </p>
      <p className="mt-auto border-t px-5 py-3 text-xs text-muted-foreground">
        {t(
          ($) => {
            return $.ssh.summary;
          },
          { count: configuredCount },
        )}
      </p>
    </Link>
  );
}
