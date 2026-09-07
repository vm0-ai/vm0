import { useGet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";

import {
  defaultModelSubmission$,
  updateDefaultModelPreference$,
} from "../../../../signals/okou-page/settings/default-model-preference.ts";
import {
  submittedCloudBrowserEnabledByDefault$,
  updateCloudBrowserEnabledByDefault$,
} from "../../../../signals/okou-page/settings/cloud-browser-preference.ts";
import {
  submittedSendMode$,
  updateSendMode$,
} from "../../../../signals/okou-page/settings/send-mode-preference.ts";

export type ChatPreferenceActions = ReturnType<typeof useChatPreferenceActions>;

/** Share invocation state across settings sections and dialog visibility. */
export function useChatPreferenceActions() {
  const [modelLoadable, updateModel] = useLoadableSet(
    updateDefaultModelPreference$,
  );
  const modelSubmission = useGet(defaultModelSubmission$);
  const [cloudBrowserLoadable, updateCloudBrowser] = useLoadableSet(
    updateCloudBrowserEnabledByDefault$,
  );
  const cloudBrowserSubmission = useGet(submittedCloudBrowserEnabledByDefault$);
  const [sendModeLoadable, updateSendMode] = useLoadableSet(updateSendMode$);
  const sendModeSubmission = useGet(submittedSendMode$);

  return {
    model: {
      update: updateModel,
      submission: modelLoadable.state === "loading" ? modelSubmission : null,
    },
    cloudBrowser: {
      update: updateCloudBrowser,
      submission:
        cloudBrowserLoadable.state === "loading"
          ? cloudBrowserSubmission
          : null,
    },
    sendMode: {
      update: updateSendMode,
      submission:
        sendModeLoadable.state === "loading" ? sendModeSubmission : null,
    },
  };
}
