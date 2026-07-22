import { IconAlertCircle, IconLoader2 } from "@tabler/icons-react";
import type { PublicConnectorCatalogIcon } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { Button } from "@vm0/ui/components/ui/button";
import type { ConnectorRedirectingStatus } from "../../signals/connectors-page/connector-redirecting.ts";
import { VM0Logo } from "../components/vm0-logo.tsx";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";

export function ZeroConnectorRedirectingPage({
  connectorLabel,
  connectorIcon,
  status,
}: {
  readonly connectorLabel: string;
  readonly connectorIcon: PublicConnectorCatalogIcon | undefined;
  readonly status: ConnectorRedirectingStatus;
}) {
  const hasError = status === "error";

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-background">
      <div className="flex w-[430px] max-w-[calc(100%-48px)] flex-col items-center gap-12 rounded-[20px] border border-border bg-background px-6 py-12 text-center">
        <VM0Logo />
        <div className="flex w-full flex-col items-center gap-4">
          <div className="flex items-center justify-center rounded-[10px] bg-gray-50 p-2.5 dark:bg-muted">
            <ConnectorIcon icon={connectorIcon} size={20} />
          </div>
          <div className="flex flex-col items-center gap-2.5">
            <h1 className="text-lg font-medium text-foreground">
              {hasError
                ? `Couldn’t open ${connectorLabel}`
                : `Redirecting to ${connectorLabel}…`}
            </h1>
            <p className="w-64 text-sm text-muted-foreground">
              {hasError
                ? "Return to Zero and try connecting again."
                : `You’ll continue on ${connectorLabel} to authorize Zero.`}
            </p>
          </div>
          {hasError ? (
            <div className="flex flex-col items-center gap-4">
              <div className="flex items-center gap-2 text-sm text-destructive">
                <IconAlertCircle size={16} aria-hidden="true" />
                <span>Unable to start the connection</span>
              </div>
              <Button
                variant="outline"
                onClick={() => {
                  window.close();
                }}
              >
                Close window
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <IconLoader2
                size={16}
                className="animate-spin"
                aria-hidden="true"
              />
              <span>Preparing a secure connection</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
