import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  IconDownload,
  IconShare2,
  IconSquarePlus,
  IconX,
} from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Button,
} from "@vm0/ui";
import {
  installBannerVisible$,
  iosInstallModalOpen$,
  triggerInstall$,
  closeIosInstallModal$,
  dismissInstallBanner$,
} from "../../signals/pwa-install.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function InstallBanner() {
  const { t } = useTranslation();
  const visible = useGet(installBannerVisible$);
  const trigger = useSet(triggerInstall$);
  const dismiss = useSet(dismissInstallBanner$);
  const pageSignal = useGet(pageSignal$);

  if (!visible) {
    return null;
  }

  return (
    <div className="shrink-0 flex items-center gap-2 bg-primary/5 border-b border-primary/20 px-3 py-2 text-sm">
      <IconDownload size={16} className="text-primary shrink-0" />
      <span className="flex-1 min-w-0 truncate text-foreground">
        {t(($) => {
          return $.lifecycle.pwaInstall.banner;
        })}
      </span>
      <button
        type="button"
        aria-label={t(($) => {
          return $.lifecycle.pwaInstall.installApp;
        })}
        onClick={() => {
          detach(trigger(pageSignal), Reason.DomCallback);
        }}
        className="h-7 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity shrink-0"
      >
        {t(($) => {
          return $.lifecycle.pwaInstall.install;
        })}
      </button>
      <button
        type="button"
        onClick={() => {
          dismiss();
        }}
        className="h-7 w-7 shrink-0 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        aria-label={t(($) => {
          return $.lifecycle.pwaInstall.dismiss;
        })}
      >
        <IconX size={14} />
      </button>
    </div>
  );
}

export function IosInstallModal() {
  const { t } = useTranslation();
  const open = useGet(iosInstallModalOpen$);
  const close = useSet(closeIosInstallModal$);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          close();
        }
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.lifecycle.pwaInstall.title;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.lifecycle.pwaInstall.description;
            })}
          </DialogDescription>
        </DialogHeader>
        <ol className="space-y-3 text-sm text-foreground">
          <li className="flex items-start gap-3">
            <span className="shrink-0 flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-medium">
              1
            </span>
            <span className="flex-1 flex items-center gap-1.5 flex-wrap">
              <IconShare2 size={16} className="inline" aria-hidden />
              {t(($) => {
                return $.lifecycle.pwaInstall.stepOne;
              })}
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span className="shrink-0 flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-medium">
              2
            </span>
            <span className="flex-1 flex items-center gap-1.5 flex-wrap">
              <IconSquarePlus size={16} className="inline" aria-hidden />
              {t(($) => {
                return $.lifecycle.pwaInstall.stepTwo;
              })}
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span className="shrink-0 flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-medium">
              3
            </span>
            <span className="flex-1">
              {t(($) => {
                return $.lifecycle.pwaInstall.stepThree;
              })}
            </span>
          </li>
        </ol>
        <DialogFooter>
          <Button
            onClick={() => {
              close();
            }}
          >
            {t(($) => {
              return $.lifecycle.pwaInstall.gotIt;
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
