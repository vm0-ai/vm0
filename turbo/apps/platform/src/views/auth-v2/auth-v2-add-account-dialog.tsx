import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";

import {
  authV2AddAccountDialogModel$,
  closeAuthV2AddAccountDialog$,
  type AuthV2AddAccountDialogModel,
} from "../../signals/okou-page/auth-v2-add-account-dialog.ts";
import { AuthV2ContinuationCard } from "./continuation/continuation-card.tsx";
import { AuthV2SignInCard } from "./sign-in/sign-in-card.tsx";
import { useAuthV2SignInCopy } from "./sign-in/sign-in-copy.ts";

function AuthV2AddAccountDialogContent({
  model,
}: {
  readonly model: AuthV2AddAccountDialogModel;
}) {
  const { t } = useTranslation();
  const copy = useAuthV2SignInCopy(model.platformContext.authBrand);
  const closeDialog = useSet(closeAuthV2AddAccountDialog$);
  const continuationState = useGet(model.continuationSignals.state$);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          closeDialog();
        }
      }}
    >
      <DialogContent
        className="zero-app max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[25rem] gap-0 overflow-y-auto border-0 bg-transparent p-0 shadow-none [&_[data-slot=dialog-close]]:right-4 [&_[data-slot=dialog-close]]:top-4 [&_[data-slot=dialog-close]]:z-10"
        closeLabel={t(($) => {
          return $.settings.shared.close;
        })}
        data-testid="auth-v2-add-account-dialog"
      >
        <DialogTitle className="sr-only">{copy.signInTitle}</DialogTitle>
        <DialogDescription className="sr-only">
          {copy.startSubtitle}
        </DialogDescription>
        {continuationState.status !== "inactive" ? (
          <AuthV2ContinuationCard
            authBrand={model.platformContext.authBrand}
            signals={model.continuationSignals}
            state={continuationState}
            surface="dialog"
          />
        ) : (
          <AuthV2SignInCard
            authBrand={model.platformContext.authBrand}
            navigation={model.platformContext.navigation}
            signals={model.signInSignals}
            surface="dialog"
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function AuthV2AddAccountDialog() {
  const model = useGet(authV2AddAccountDialogModel$);
  return model ? <AuthV2AddAccountDialogContent model={model} /> : null;
}
