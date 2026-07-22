import type { PublicConnectorCatalogIcon } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import type { ReactNode } from "react";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import { Vm0LogoLink } from "./zero-directed-shared.tsx";

export function ZeroConnectorFlowCard({
  connectorIcon,
  title,
  description,
  children,
}: {
  readonly connectorIcon: PublicConnectorCatalogIcon | undefined;
  readonly title: string;
  readonly description: ReactNode;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-background pointer-events-none">
      <div className="pointer-events-auto flex w-[430px] max-w-[calc(100%-48px)] flex-col items-center gap-12 rounded-[20px] border border-border bg-background px-6 py-12 text-center">
        <Vm0LogoLink />
        <div
          className="flex w-full flex-col items-center gap-4"
          aria-live="polite"
        >
          <div className="flex flex-col items-center gap-2.5">
            <h1 className="text-lg font-medium text-foreground">{title}</h1>
            <div className="flex items-center justify-center rounded-[10px] bg-muted p-2.5">
              <ConnectorIcon icon={connectorIcon} size={20} />
            </div>
            <p className="w-64 text-sm text-muted-foreground">{description}</p>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
