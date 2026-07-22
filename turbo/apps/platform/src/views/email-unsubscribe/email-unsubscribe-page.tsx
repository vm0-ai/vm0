import { useGet, useSet } from "ccstate-react";
import { Button } from "@vm0/ui";
import { IconAlertCircle, IconCheck, IconLoader2 } from "@tabler/icons-react";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  confirmEmailUnsubscribe$,
  emailUnsubscribeScope$,
  emailUnsubscribeStatus$,
  emailUnsubscribeToken$,
} from "../../signals/email-unsubscribe/email-unsubscribe-signals.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { VM0Logo } from "../components/vm0-logo.tsx";

export function EmailUnsubscribePage() {
  const pageSignal = useGet(pageSignal$);
  const status = useGet(emailUnsubscribeStatus$);
  const scope = useGet(emailUnsubscribeScope$);
  const token = useGet(emailUnsubscribeToken$);
  const confirm = useSet(confirmEmailUnsubscribe$);

  const isMorningBrief = scope === "morning-brief";
  const title = isMorningBrief
    ? "Turn off the Morning Brief?"
    : "Unsubscribe from email notifications?";
  const description = isMorningBrief
    ? "You will no longer receive the daily Morning Brief email. You can turn it back on any time in Settings."
    : "You will no longer receive system-initiated email notifications from VM0.";

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-background">
      <div className="flex w-[430px] max-w-[calc(100%-48px)] flex-col items-center gap-8 rounded-[20px] border border-border bg-background px-6 py-12 text-center">
        <VM0Logo />
        {status === "done" ? (
          <div className="flex flex-col items-center gap-2.5">
            <IconCheck size={20} className="text-muted-foreground" />
            <h1 className="text-lg font-medium text-foreground">
              {isMorningBrief ? "Morning Brief turned off" : "Unsubscribed"}
            </h1>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
        ) : status === "error" || !token ? (
          <div className="flex flex-col items-center gap-2.5">
            <IconAlertCircle size={20} className="text-destructive" />
            <h1 className="text-lg font-medium text-foreground">
              Something went wrong
            </h1>
            <p className="text-sm text-muted-foreground">
              This unsubscribe link is invalid or expired. You can manage email
              notifications in Settings.
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4">
            <div className="flex flex-col items-center gap-2.5">
              <h1 className="text-lg font-medium text-foreground">{title}</h1>
              <p className="text-sm text-muted-foreground">{description}</p>
            </div>
            <Button
              disabled={status === "submitting"}
              onClick={() => {
                detach(confirm(pageSignal), Reason.DomCallback);
              }}
            >
              {status === "submitting" ? (
                <IconLoader2 size={16} className="animate-spin" />
              ) : null}
              {isMorningBrief ? "Turn off Morning Brief" : "Unsubscribe"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
