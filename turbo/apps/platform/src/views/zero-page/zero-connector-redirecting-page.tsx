import { IconAlertCircle, IconLoader2 } from "@tabler/icons-react";
import type { PublicConnectorCatalogIcon } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { Button } from "@vm0/ui/components/ui/button";
import type { ConnectorRedirectingStatus } from "../../signals/connectors-page/connector-redirecting.ts";
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
  const hasError = status === "error";

  return (
    <ZeroConnectorFlowCard
      connectorIcon={connectorIcon}
      title={
        hasError
          ? `Couldn’t open ${connectorLabel}`
          : `Redirecting to ${connectorLabel}…`
      }
      description={
        hasError
          ? "Return to VM0 and try connecting again."
          : `You’ll continue on ${connectorLabel} to authorize VM0.`
      }
    >
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
          <IconLoader2 size={16} className="animate-spin" aria-hidden="true" />
          <span>Preparing a secure connection</span>
        </div>
      )}
    </ZeroConnectorFlowCard>
  );
}
