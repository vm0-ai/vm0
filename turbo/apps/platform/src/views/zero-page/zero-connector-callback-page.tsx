import { IconAlertCircle, IconCheck, IconLoader2 } from "@tabler/icons-react";
import type { PublicConnectorCatalogIcon } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { Button } from "@vm0/ui/components/ui/button";
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
  const title =
    status === "success"
      ? `${connectorLabel} connected`
      : status === "error"
        ? `Couldn’t connect ${connectorLabel}`
        : `Connecting ${connectorLabel}…`;
  const description =
    status === "success" ? (
      username ? (
        <>
          Connected as <strong>{username}</strong>. You can close this window.
        </>
      ) : (
        "Your account has been connected. You can close this window."
      )
    ) : status === "error" ? (
      <>
        {errorMessage || "An error occurred during connection."} Close this
        window and try again.
      </>
    ) : (
      "Please wait while we finish connecting your account."
    );

  return (
    <ZeroConnectorFlowCard
      connectorIcon={connectorIcon}
      title={title}
      description={description}
    >
      {status === "loading" ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <IconLoader2 size={16} className="animate-spin" aria-hidden="true" />
          <span>Finishing the secure connection</span>
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
              {status === "success" ? "Connected" : "Connection failed"}
            </span>
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
      )}
    </ZeroConnectorFlowCard>
  );
}
