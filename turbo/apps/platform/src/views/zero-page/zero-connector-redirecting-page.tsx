import {
  IconAlertCircle,
  IconArrowLeft,
  IconLoader2,
} from "@tabler/icons-react";
import type { PublicConnectorCatalogIcon } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { Button } from "@vm0/ui/components/ui/button";
import { useGet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  connectorRedirectingMobileWarningVisible$,
  type ConnectorRedirectingStatus,
} from "../../signals/connectors-page/connector-redirecting.ts";
import { brandName$ } from "../../signals/branding.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { Link } from "../router/link.tsx";
import { ZeroConnectorFlowCard } from "./zero-connector-flow-card.tsx";

export function ZeroConnectorRedirectingPage({
  connectorLabel,
  connectorIcon,
  status,
}: {
  readonly connectorLabel: string;
  readonly connectorIcon: PublicConnectorCatalogIcon | undefined;
  readonly status: ConnectorRedirectingStatus;
}) {
  const { t } = useTranslation();
  const hasError = status === "error";
  const brandName = useGet(brandName$);
  const showMobileWarning = useGet(connectorRedirectingMobileWarningVisible$);

  return (
    <ZeroConnectorFlowCard
      connectorIcon={connectorIcon}
      title={
        hasError
          ? t(
              ($) => {
                return $.connectors.redirect.errorTitle;
              },
              { connector: connectorLabel },
            )
          : t(
              ($) => {
                return $.connectors.redirect.redirectTitle;
              },
              { connector: connectorLabel },
            )
      }
      description={
        hasError
          ? t(
              ($) => {
                return $.connectors.redirect.errorDescription;
              },
              { brandName },
            )
          : t(
              ($) => {
                return $.connectors.redirect.redirectDescription;
              },
              { connector: connectorLabel, brandName },
            )
      }
    >
      <div className="flex flex-col items-center gap-4">
        {hasError ? (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <IconAlertCircle size={16} aria-hidden="true" />
            <span>
              {t(($) => {
                return $.connectors.redirect.errorStatus;
              })}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <IconLoader2
              size={16}
              className="animate-spin"
              aria-hidden="true"
            />
            <span>
              {t(($) => {
                return $.connectors.redirect.preparing;
              })}
            </span>
          </div>
        )}
        {!hasError && showMobileWarning && (
          <p className="w-72 max-w-full text-sm text-amber-600 dark:text-amber-400">
            {t(
              ($) => {
                return $.connectors.redirect.mobileWarning;
              },
              { connector: connectorLabel, brandName },
            )}
          </p>
        )}
        <Button variant="outline" asChild>
          <Link pathname={ROUTES.home}>
            <IconArrowLeft size={16} aria-hidden="true" />
            {t(
              ($) => {
                return $.connectors.redirect.back;
              },
              { brandName },
            )}
          </Link>
        </Button>
      </div>
    </ZeroConnectorFlowCard>
  );
}
