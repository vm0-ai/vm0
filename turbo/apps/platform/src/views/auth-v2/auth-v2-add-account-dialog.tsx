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
        maxWidth="25rem"
        surface="transparent"
        contentClassName="okou-app gap-0 overflow-y-auto p-0"
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
            operationSignal$={model.operationSignal$}
            signals={model.continuationSignals}
            state={continuationState}
            surface="dialog"
          />
        ) : (
          <AuthV2SignInCard
            authBrand={model.platformContext.authBrand}
            navigation={model.platformContext.navigation}
            operationSignal$={model.operationSignal$}
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
