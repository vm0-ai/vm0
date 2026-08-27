import { setupEmailUnsubscribePage$ } from "../email-unsubscribe/email-unsubscribe-page-setup.ts";
import { setupLabPage$ } from "../lab-page/lab-page-setup.ts";
import { setupMorningBriefUnsubscribePage$ } from "../morning-brief-unsubscribe/morning-brief-unsubscribe-page-setup.ts";
import { setupSharedThreadPage$ } from "../shared-thread-page/shared-thread-page-setup.ts";
import { setupSignInTokenPage$ } from "../sign-in-token-setup.ts";

export function getMiscRouteSetups() {
  return {
    setupEmailUnsubscribePage$,
    setupLabPage$,
    setupMorningBriefUnsubscribePage$,
    setupSharedThreadPage$,
    setupSignInTokenPage$,
  };
}
