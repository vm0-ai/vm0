import type { ReactNode } from "react";
import { useSet } from "ccstate-react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { registerConnectorConnectionDialog$ } from "../../signals/connector-connection-progress.ts";

export function ConnectorConnectionStatus() {
  const { t } = useTranslation();
  return (
    <div role="status" className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.connectors.connectionProgress.description;
        })}
      </p>
      <div className="flex justify-center py-6" aria-hidden="true">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    </div>
  );
}

export function ConnectorConnectionDialogBody({
  children,
}: {
  readonly children: ReactNode;
}) {
  const register = useSet(registerConnectorConnectionDialog$);
  return <div ref={register}>{children}</div>;
}
