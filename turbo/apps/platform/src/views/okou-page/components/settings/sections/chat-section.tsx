import { useGet, useLastResolved, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Cpu, Globe, Keyboard, Loader2 } from "lucide-react";
import { ChoiceButton } from "@okouai/ui";
import { Switch } from "@okouai/ui/components/ui/switch";
import type { SendMode } from "@okouai/api-contracts/contracts/user-preferences";

import { codexFastModeEnabled$ } from "../../../../../signals/external/feature-switch.ts";
import { orgModelPolicies$ } from "../../../../../signals/external/org-model-policies.ts";
import { userModelPreference$ } from "../../../../../signals/external/user-model-preference.ts";
import { pageSignal$ } from "../../../../../signals/page-signal.ts";
import { sendMode$ } from "../../../../../signals/send-mode.ts";
import { cloudBrowserEnabledByDefault$ } from "../../../../../signals/cloud-browser-preference.ts";
import { detach, Reason } from "../../../../../signals/utils.ts";
import { resolveModelFirstStoredUserSelection } from "../../../../../signals/okou-page/model-default-selection.ts";
import {
  defaultModelSubmission$,
  updateDefaultModelPreference$,
} from "../../../../../signals/okou-page/settings/default-model-preference.ts";
import {
  submittedCloudBrowserEnabledByDefault$,
  updateCloudBrowserEnabledByDefault$,
} from "../../../../../signals/okou-page/settings/cloud-browser-preference.ts";
import {
  submittedSendMode$,
  updateSendMode$,
} from "../../../../../signals/okou-page/settings/send-mode-preference.ts";
import { ModelProviderPicker } from "../../model-provider-picker.tsx";
import { PreferenceCardRow } from "../preference-card-row.tsx";

const SEND_OPTIONS: readonly SendMode[] = ["enter", "cmd-enter"];

function DefaultModelPreference() {
  const { t } = useTranslation();
  const userPreference = useLastResolved(userModelPreference$);
  const policies = useLastResolved(orgModelPolicies$);
  const codexFastModeEnabled = useGet(codexFastModeEnabled$);
  const [updateLoadable, updatePreference] = useLoadableSet(
    updateDefaultModelPreference$,
  );
  const submitted = useGet(defaultModelSubmission$);
  const submission = updateLoadable.state === "loading" ? submitted : null;
  const pageSignal = useGet(pageSignal$);
  const current = resolveModelFirstStoredUserSelection({
    userPreference,
    policies,
    codexFastModeEnabled,
  });
  const effective = submission === null ? current : submission.selection;
  const mutating = submission !== null;

  const handleChange = (selection: Parameters<typeof updatePreference>[0]) => {
    detach(updatePreference(selection, pageSignal), Reason.DomCallback);
  };

  return (
    <PreferenceCardRow
      icon={Cpu}
      title={t(($) => {
        return $.settings.preferences.chat.defaultModel.title;
      })}
      description={t(($) => {
        return $.settings.preferences.chat.defaultModel.description;
      })}
    >
      <ModelProviderPicker
        value={effective}
        onChange={handleChange}
        triggerClassName="h-9 w-full sm:w-[260px]"
        disabled={
          userPreference === undefined || policies === undefined || mutating
        }
        codexFastModeEnabled={codexFastModeEnabled}
        showInheritOption
      />
    </PreferenceCardRow>
  );
}

function CloudBrowserDefaultPreference() {
  const { t } = useTranslation();
  const preferenceLoadable = useLoadable(cloudBrowserEnabledByDefault$);
  const current =
    preferenceLoadable.state === "hasData" ? preferenceLoadable.data : true;
  const [updateLoadable, updatePreference] = useLoadableSet(
    updateCloudBrowserEnabledByDefault$,
  );
  const submitted = useGet(submittedCloudBrowserEnabledByDefault$);
  const submission = updateLoadable.state === "loading" ? submitted : null;
  const pageSignal = useGet(pageSignal$);
  const mutating = submission !== null;
  const effective = submission ?? current;

  const handleToggle = (checked: boolean) => {
    detach(updatePreference(checked, pageSignal), Reason.DomCallback);
  };

  return (
    <PreferenceCardRow
      icon={Globe}
      title={t(($) => {
        return $.settings.preferences.chat.cloudBrowser.title;
      })}
      description={t(($) => {
        return $.settings.preferences.chat.cloudBrowser.description;
      })}
    >
      <Switch
        aria-label={t(($) => {
          return $.settings.preferences.chat.cloudBrowser.title;
        })}
        checked={effective}
        onCheckedChange={handleToggle}
        disabled={preferenceLoadable.state !== "hasData" || mutating}
      />
    </PreferenceCardRow>
  );
}

export function SendModePreference() {
  const { t } = useTranslation();
  const prefsLoadable = useLoadable(sendMode$);
  const current: SendMode =
    prefsLoadable.state === "hasData" ? prefsLoadable.data : "enter";
  const [saveLoadable, saveSendMode] = useLoadableSet(updateSendMode$);
  const submitted = useGet(submittedSendMode$);
  const saving = saveLoadable.state === "loading" ? submitted : null;
  const pageSignal = useGet(pageSignal$);

  const handleChange = (value: SendMode) => {
    detach(saveSendMode(value, pageSignal), Reason.DomCallback);
  };

  const effective: SendMode = saving ?? current;

  return (
    <PreferenceCardRow
      icon={Keyboard}
      title={t(($) => {
        return $.settings.preferences.send.title;
      })}
      description={
        effective === "enter"
          ? t(($) => {
              return $.settings.preferences.send.enterDescription;
            })
          : t(($) => {
              return $.settings.preferences.send.cmdEnterDescription;
            })
      }
    >
      <div className="flex flex-wrap gap-2 shrink-0">
        {SEND_OPTIONS.map((value) => {
          const isActive =
            saving === value ? true : saving === null && current === value;
          const label =
            value === "enter"
              ? t(($) => {
                  return $.settings.preferences.send.enter;
                })
              : t(($) => {
                  return $.settings.preferences.send.cmdEnter;
                });
          return (
            <ChoiceButton
              key={value}
              type="button"
              selected={isActive}
              disabled={saving !== null}
              onClick={() => {
                handleChange(value);
              }}
            >
              {saving === value && (
                <Loader2 size={14} className="animate-spin" />
              )}
              {label}
            </ChoiceButton>
          );
        })}
      </div>
    </PreferenceCardRow>
  );
}

export function ChatSection() {
  return (
    <div className="flex flex-col gap-3">
      <DefaultModelPreference />
      <CloudBrowserDefaultPreference />
      <SendModePreference />
    </div>
  );
}
