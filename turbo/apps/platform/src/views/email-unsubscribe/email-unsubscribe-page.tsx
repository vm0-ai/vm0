import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Button } from "@vm0/ui";
import { IconAlertCircle, IconCheck, IconLoader2 } from "@tabler/icons-react";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { brandName$ } from "../../signals/branding.ts";
import {
  confirmEmailUnsubscribe$,
  emailUnsubscribeStatus$,
  emailUnsubscribeToken$,
} from "../../signals/email-unsubscribe/email-unsubscribe-signals.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { VM0Logo } from "../components/vm0-logo.tsx";

export function EmailUnsubscribePage() {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const brandName = useGet(brandName$);
  const status = useGet(emailUnsubscribeStatus$);
  const token = useGet(emailUnsubscribeToken$);
  const confirm = useSet(confirmEmailUnsubscribe$);

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-background">
      <div className="flex w-[430px] max-w-[calc(100%-48px)] flex-col items-center gap-8 rounded-[20px] border border-border bg-background px-6 py-12 text-center">
        <VM0Logo />
        {status === "done" ? (
          <div className="flex flex-col items-center gap-2.5">
            <IconCheck size={20} className="text-muted-foreground" />
            <h1 className="text-lg font-medium text-foreground">
              {t(($) => {
                return $.lifecycle.emailUnsubscribe.doneTitle;
              })}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t(
                ($) => {
                  return $.lifecycle.emailUnsubscribe.body;
                },
                { brandName },
              )}
            </p>
          </div>
        ) : status === "error" || !token ? (
          <div className="flex flex-col items-center gap-2.5">
            <IconAlertCircle size={20} className="text-destructive" />
            <h1 className="text-lg font-medium text-foreground">
              {t(($) => {
                return $.lifecycle.emailUnsubscribe.errorTitle;
              })}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t(($) => {
                return $.lifecycle.emailUnsubscribe.errorBody;
              })}
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4">
            <div className="flex flex-col items-center gap-2.5">
              <h1 className="text-lg font-medium text-foreground">
                {t(($) => {
                  return $.lifecycle.emailUnsubscribe.confirmTitle;
                })}
              </h1>
              <p className="text-sm text-muted-foreground">
                {t(
                  ($) => {
                    return $.lifecycle.emailUnsubscribe.body;
                  },
                  { brandName },
                )}
              </p>
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
              {t(($) => {
                return $.lifecycle.emailUnsubscribe.action;
              })}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
