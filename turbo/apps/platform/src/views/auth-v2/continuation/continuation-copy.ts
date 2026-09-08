import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import type { AuthBrandContext } from "../../../signals/auth.ts";

export interface AuthV2ContinuationCopy {
  readonly securityTitle: string;
  readonly securityDescription: string;
  readonly setupKeyDescription: string;
  readonly setupKey: string;
  readonly phoneNumberLabel: string;
  readonly invitationError: string;
  readonly retry: string;
  readonly backupTitle: string;
  readonly backupDescription: string;
  readonly savedCodes: string;
  readonly createOrganization: string;
  readonly organizationName: string;
  readonly taskError: string;
  readonly passwordTaskError: string;
  readonly taskComplete: string;
  readonly sendCode: string;
  readonly joinOrganization: (organizationName: string) => string;

  readonly activationErrorDescription: string;
  readonly activationErrorTitle: string;
  readonly chooseOrganizationDescription: string;
  readonly chooseOrganizationTitle: string;
  readonly completeDescription: string;
  readonly completeTitle: string;
  readonly loadingDescription: string;
  readonly loadingTitle: string;
  readonly noOrganizationsDescription: string;
  readonly noOrganizationsTitle: string;
  readonly recoveryAction: string;
  readonly secondFactorDescription: string;
  readonly secondFactorTitle: string;
  readonly selectOrganization: (organizationName: string) => string;
  readonly signedInAs: (identifier: string) => string;
  readonly signOut: string;
  readonly unsupportedDescription: string;
  readonly unsupportedTitle: string;
}

function securityTaskCopy(t: TFunction<"common">) {
  return {
    securityTitle: t(($) => {
      return $.auth.v2.continuation.securityTitle;
    }),
    securityDescription: t(($) => {
      return $.auth.v2.continuation.securityDescription;
    }),
    setupKeyDescription: t(($) => {
      return $.auth.v2.continuation.setupKeyDescription;
    }),
    setupKey: t(($) => {
      return $.auth.v2.continuation.setupKey;
    }),
    phoneNumberLabel: t(($) => {
      return $.auth.v2.continuation.phoneNumberLabel;
    }),
    backupTitle: t(($) => {
      return $.auth.v2.continuation.backupTitle;
    }),
    backupDescription: t(($) => {
      return $.auth.v2.continuation.backupDescription;
    }),
    savedCodes: t(($) => {
      return $.auth.v2.continuation.savedCodes;
    }),
    createOrganization: t(($) => {
      return $.auth.v2.continuation.createOrganization;
    }),
    organizationName: t(($) => {
      return $.auth.v2.continuation.organizationName;
    }),
    taskError: t(($) => {
      return $.auth.v2.continuation.taskError;
    }),
    passwordTaskError: t(($) => {
      return $.auth.v2.continuation.passwordTaskError;
    }),
    taskComplete: t(($) => {
      return $.auth.v2.continuation.taskComplete;
    }),
    sendCode: t(($) => {
      return $.auth.v2.continuation.sendCode;
    }),
    joinOrganization: (organizationName: string) => {
      return t(
        ($) => {
          return $.auth.v2.continuation.joinOrganization;
        },
        { organizationName },
      );
    },
    invitationError: t(($) => {
      return $.auth.v2.continuation.invitationError;
    }),
    retry: t(($) => {
      return $.auth.v2.signUp.retry;
    }),
  };
}

export function useAuthV2ContinuationCopy(
  brandName: AuthBrandContext["brandName"],
): AuthV2ContinuationCopy {
  const { t } = useTranslation();
  return {
    ...securityTaskCopy(t),
    activationErrorDescription: t(($) => {
      return $.auth.v2.continuation.activationErrorDescription;
    }),
    activationErrorTitle: t(($) => {
      return $.auth.v2.continuation.activationErrorTitle;
    }),
    chooseOrganizationDescription: t(
      ($) => {
        return $.auth.v2.continuation.chooseOrganizationDescription;
      },
      { brandName },
    ),
    chooseOrganizationTitle: t(($) => {
      return $.auth.v2.continuation.chooseOrganizationTitle;
    }),
    completeDescription: t(
      ($) => {
        return $.auth.v2.continuation.completeDescription;
      },
      { brandName },
    ),
    completeTitle: t(($) => {
      return $.auth.v2.continuation.completeTitle;
    }),
    loadingDescription: t(($) => {
      return $.auth.v2.continuation.loadingDescription;
    }),
    loadingTitle: t(($) => {
      return $.auth.v2.continuation.loadingTitle;
    }),
    noOrganizationsDescription: t(($) => {
      return $.auth.v2.continuation.noOrganizationsDescription;
    }),
    noOrganizationsTitle: t(($) => {
      return $.auth.v2.continuation.noOrganizationsTitle;
    }),
    recoveryAction: t(($) => {
      return $.auth.v2.continuation.recoveryAction;
    }),
    secondFactorDescription: t(($) => {
      return $.auth.v2.continuation.secondFactorDescription;
    }),
    secondFactorTitle: t(($) => {
      return $.auth.v2.continuation.secondFactorTitle;
    }),
    selectOrganization: (organizationName) => {
      return t(
        ($) => {
          return $.auth.v2.continuation.selectOrganization;
        },
        { organizationName },
      );
    },
    signedInAs: (identifier) => {
      return t(
        ($) => {
          return $.auth.v2.continuation.signedInAs;
        },
        { identifier },
      );
    },
    signOut: t(($) => {
      return $.settings.accountMenu.signOut;
    }),
    unsupportedDescription: t(($) => {
      return $.auth.v2.continuation.unsupportedDescription;
    }),
    unsupportedTitle: t(($) => {
      return $.auth.v2.continuation.unsupportedTitle;
    }),
  };
}
