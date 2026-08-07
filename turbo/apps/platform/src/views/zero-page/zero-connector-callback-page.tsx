import { IconAlertCircle, IconCheck, IconLoader2 } from "@tabler/icons-react";
import type { PublicConnectorCatalogIcon } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { Button } from "@vm0/ui/components/ui/button";
import { useTranslation } from "react-i18next";
import { ZeroConnectorFlowCard } from "./zero-connector-flow-card.tsx";

type ConnectorCallbackPageStatus = "loading" | "success" | "error";

export function ZeroConnectorCallbackPage({
  connectorIcon,
  connectorLabel,
  status,
  username,
  errorMessage,
}: {
  readonly connectorIcon: PublicConnectorCatalogIcon | undefined;
  readonly connectorLabel: string;
  readonly status: ConnectorCallbackPageStatus;
  readonly username: string | null;
  readonly errorMessage: string | null;
}): React.JSX.Element {
  const { t } = useTranslation();
  const title =
    status === "success"
      ? t(
          ($) => {
            return $.connectors.callback.connected;
          },
          { connector: connectorLabel },
        )
      : status === "error"
        ? t(
            ($) => {
              return $.connectors.callback.failedTitle;
            },
            { connector: connectorLabel },
          )
        : t(
            ($) => {
              return $.connectors.callback.connecting;
            },
            { connector: connectorLabel },
          );
  const description =
    status === "success"
      ? username
        ? t(
            ($) => {
              return $.connectors.callback.connectedAs;
            },
            { username },
          )
        : t(($) => {
            return $.connectors.callback.connectedDescription;
          })
      : status === "error"
        ? t(
            ($) => {
              return $.connectors.callback.errorDescription;
            },
            {
              error:
                errorMessage ??
                t(($) => {
                  return $.connectors.callback.errorFallback;
                }),
            },
          )
        : t(($) => {
            return $.connectors.callback.connectingDescription;
          });

  return (
    <ZeroConnectorFlowCard
      connectorIcon={connectorIcon}
      title={title}
      description={description}
    >
      {status === "loading" ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <IconLoader2 size={16} className="animate-spin" aria-hidden="true" />
          <span>
            {t(($) => {
              return $.connectors.callback.finishing;
            })}
          </span>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4">
          <div
            className={
              status === "success"
                ? "flex items-center gap-2 text-sm text-emerald-600"
                : "flex items-center gap-2 text-sm text-destructive"
            }
          >
            {status === "success" ? (
              <IconCheck size={16} aria-hidden="true" />
            ) : (
              <IconAlertCircle size={16} aria-hidden="true" />
            )}
            <span>
              {status === "success"
                ? t(($) => {
                    return $.connectors.callback.success;
                  })
                : t(($) => {
                    return $.connectors.callback.failed;
                  })}
            </span>
          </div>
          <Button
            variant="outline"
            onClick={() => {
              window.close();
            }}
          >
            {t(($) => {
              return $.connectors.actions.closeWindow;
            })}
          </Button>
        </div>
      )}
    </ZeroConnectorFlowCard>
  );
}
