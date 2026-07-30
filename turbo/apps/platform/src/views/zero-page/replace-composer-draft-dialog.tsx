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

export function ReplaceComposerDraftDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="zero-app sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.chat.replaceDraft.title;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.chat.replaceDraft.description;
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t(($) => {
              return $.chat.actions.cancel;
            })}
          </Button>
          <Button type="button" onClick={onConfirm}>
            {t(($) => {
              return $.chat.actions.continue;
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
