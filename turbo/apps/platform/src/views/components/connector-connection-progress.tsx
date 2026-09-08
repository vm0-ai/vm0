import { useGet } from "ccstate-react";
import { Loader2 } from "lucide-react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { connectorConnectionPending$ } from "../../signals/connector-connection-progress.ts";

export function ConnectorConnectionProgress() {
  const pending = useGet(connectorConnectionPending$);
  const { t } = useTranslation();

  return createPortal(
    <div
      role={pending ? "status" : undefined}
      aria-live="polite"
      aria-atomic="true"
      className="pointer-events-none fixed inset-x-4 bottom-[calc(var(--sab,0px)+16px)] z-[2147483646] flex justify-center"
    >
      {pending ? (
        <div className="flex w-full max-w-sm items-start gap-3 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg">
          <Loader2
            aria-hidden="true"
            className="mt-0.5 size-5 shrink-0 animate-spin text-muted-foreground"
          />
          <div>
            <p className="text-sm font-medium">
              {t(($) => {
                return $.connectors.connectionProgress.title;
              })}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t(($) => {
                return $.connectors.connectionProgress.description;
              })}
            </p>
          </div>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
