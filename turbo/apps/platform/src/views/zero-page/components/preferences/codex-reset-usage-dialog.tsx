import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui";
import { useTranslation } from "react-i18next";
import { formatLocalizedNumber } from "../../../../i18n/format.ts";
import { i18n } from "../../../../i18n/index.ts";

export function formatCodexResetCredits(
  value: number | null | undefined,
): string {
  if (value === null || value === undefined) {
    return i18n.t(($) => {
      return $.settings.models.reset.remainingUnavailable;
    });
  }
  return i18n.t(
    ($) => {
      return $.settings.models.reset.remaining;
    },
    {
      count: value,
      value: formatLocalizedNumber(value),
    },
  );
}

export function CodexResetUsageDialog({
  open,
  resetCredits,
  resetting,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  resetCredits: number | null;
  resetting: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const remaining = formatCodexResetCredits(resetCredits);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!resetting) {
          onOpenChange(next);
        }
      }}
    >
      <DialogContent
        closeLabel={t(($) => {
          return $.settings.shared.close;
        })}
      >
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.settings.models.reset.title;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(
              ($) => {
                return $.settings.models.reset.confirmDescription;
              },
              {
                remaining,
              },
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={resetting}
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t(($) => {
              return $.settings.shared.cancel;
            })}
          </Button>
          <Button
            type="button"
            disabled={resetting || resetCredits === 0}
            onClick={onConfirm}
          >
            {resetting
              ? t(($) => {
                  return $.settings.models.reset.progress;
                })
              : t(($) => {
                  return $.settings.models.actions.resetUsage;
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
