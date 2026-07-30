import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui";
import { useTranslation } from "react-i18next";

export function CustomConnectorUpdateConfirm({
  submitting,
  onCancel,
  onConfirm,
}: {
  readonly submitting: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        return !open && onCancel();
      }}
    >
      <DialogContent
        className="max-w-md"
        aria-describedby={undefined}
        closeLabel={t(($) => {
          return $.connectors.actions.close;
        })}
      >
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.connectors.custom.updateConfirm.title;
            })}
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.connectors.custom.updateConfirm.description;
          })}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={submitting}>
            {t(($) => {
              return $.connectors.actions.cancel;
            })}
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={submitting}
          >
            {submitting
              ? t(($) => {
                  return $.connectors.actions.savingEllipsis;
                })
              : t(($) => {
                  return $.connectors.custom.updateConfirm.action;
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
