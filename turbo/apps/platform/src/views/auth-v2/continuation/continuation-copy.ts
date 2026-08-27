import { useTranslation } from "react-i18next";

import type { AuthBrandContext } from "../../../signals/auth.ts";

export interface AuthV2ContinuationCopy {
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

export function useAuthV2ContinuationCopy(
  brandName: AuthBrandContext["brandName"],
): AuthV2ContinuationCopy {
  const { t } = useTranslation();
  return {
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
