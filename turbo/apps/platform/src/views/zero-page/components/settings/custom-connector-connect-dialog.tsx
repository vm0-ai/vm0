import type { FormEvent } from "react";

import type { CustomConnectorResponse } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui";
import { Input } from "@vm0/ui/components/ui/input";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";

import { featureSwitch$ } from "../../../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  closeCustomConnectorDialog$,
  connectCustomConnectorOAuth2$,
  connectCustomConnectorOAuth2ForAgent$,
  customConnectorConnectForm$,
  resetCustomConnectorConnectInput$,
  setCustomConnectorConnectField$,
  setCustomConnectorSecret$,
  setCustomConnectorSecretForAgent$,
} from "../../../../signals/zero-page/settings/custom-connectors.ts";
import { hasTokenInputValue } from "../../../../signals/zero-page/settings/token-input.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { CustomConnectorIcon } from "./custom-connector-icon.tsx";

type CustomConnectorAuthMethod = { readonly type: "api" | "oauth2" };

function AuthenticationMethodChoice({
  methods,
  onSelect,
}: {
  readonly methods: readonly CustomConnectorAuthMethod[];
  readonly onSelect: (type: CustomConnectorAuthMethod["type"]) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {methods.map((method) => {
        const oauth2 = method.type === "oauth2";
        return (
          <button
            key={method.type}
            type="button"
            className="rounded-xl border border-border p-4 text-left transition-colors hover:border-primary hover:bg-muted/40"
            onClick={() => {
              onSelect(method.type);
            }}
          >
            <span className="block text-sm font-medium text-foreground">
              {oauth2 ? "OAuth 2.0" : "API authentication"}
            </span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {oauth2
                ? "Authorize access with the connector's OAuth app."
                : "Enter the API secret issued by the provider."}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ApiSecretField({
  value,
  setValue,
}: {
  readonly value: string;
  readonly setValue: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor="cc-connect-secret"
        className="text-sm font-medium text-foreground"
      >
        {t(($) => {
          return $.connectors.custom.connect.secret;
        })}
      </label>
      <Input
        id="cc-connect-secret"
        type="password"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
        }}
        autoFocus
      />
    </div>
  );
}

function CredentialFields({
  selectedMethod,
  methods,
  apiSecret,
  setField,
}: {
  readonly selectedMethod: CustomConnectorAuthMethod | undefined;
  readonly methods: readonly CustomConnectorAuthMethod[];
  readonly apiSecret: string;
  readonly setField: (
    field: "authMethod" | "apiSecret",
    value: CustomConnectorAuthMethod["type"] | string | null,
  ) => void;
}) {
  if (!selectedMethod) {
    return (
      <AuthenticationMethodChoice
        methods={methods}
        onSelect={(type) => {
          setField("authMethod", type);
        }}
      />
    );
  }
  if (selectedMethod.type === "api") {
    return (
      <ApiSecretField
        value={apiSecret}
        setValue={(value) => {
          setField("apiSecret", value);
        }}
      />
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      Continue to the provider to authorize access.
    </p>
  );
}

function submitButtonLabel(
  selectedMethod: CustomConnectorAuthMethod,
  submitting: boolean,
) {
  if (selectedMethod.type === "oauth2") {
    return submitting ? "Connecting…" : "Continue";
  }
  return submitting ? "Saving…" : "Save";
}

function useCustomConnectorConnectionSubmitters(agentId: string | undefined) {
  const [apiLoadable, submitApi] = useLoadableSet(setCustomConnectorSecret$);
  const [agentApiLoadable, submitAgentApi] = useLoadableSet(
    setCustomConnectorSecretForAgent$,
  );
  const [oauthLoadable, submitOAuth2] = useLoadableSet(
    connectCustomConnectorOAuth2$,
  );
  const [agentOAuthLoadable, submitAgentOAuth2] = useLoadableSet(
    connectCustomConnectorOAuth2ForAgent$,
  );

  const submitSecret = async (
    args: { readonly id: string; readonly value: string },
    signal: AbortSignal,
  ): Promise<void> => {
    if (agentId) {
      await submitAgentApi({ ...args, agentId }, signal);
    } else {
      await submitApi(args, signal);
    }
  };
  const submitOAuth = async (
    connectorId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    if (agentId) {
      await submitAgentOAuth2({ id: connectorId, agentId }, signal);
    } else {
      await submitOAuth2(connectorId, signal);
    }
  };

  return {
    submitting:
      apiLoadable.state === "loading" ||
      agentApiLoadable.state === "loading" ||
      oauthLoadable.state === "loading" ||
      agentOAuthLoadable.state === "loading",
    submitSecret,
    submitOAuth,
  };
}

function ConnectDialogFooter({
  selectedMethod,
  multipleMethods,
  submitting,
  canSubmit,
  onBack,
  onClose,
}: {
  readonly selectedMethod: CustomConnectorAuthMethod | undefined;
  readonly multipleMethods: boolean;
  readonly submitting: boolean;
  readonly canSubmit: boolean;
  readonly onBack: () => void;
  readonly onClose: () => void;
}) {
  return (
    <DialogFooter>
      {multipleMethods && selectedMethod && (
        <Button
          type="button"
          variant="ghost"
          onClick={onBack}
          disabled={submitting}
        >
          Back
        </Button>
      )}
      <Button
        type="button"
        variant="outline"
        onClick={onClose}
        disabled={submitting}
      >
        Cancel
      </Button>
      {selectedMethod && (
        <Button type="submit" disabled={!canSubmit}>
          {submitButtonLabel(selectedMethod, submitting)}
        </Button>
      )}
    </DialogFooter>
  );
}

export function CustomConnectorConnectDialog({
  connector,
  agentId,
  onClose,
}: {
  readonly connector: CustomConnectorResponse;
  readonly agentId?: string;
  readonly onClose?: () => void;
}) {
  const { t } = useTranslation();
  const form = useGet(customConnectorConnectForm$);
  const featureSwitches = useGet(featureSwitch$);
  const oauth2Enabled =
    featureSwitches[FeatureSwitchKey.CustomConnectorOAuth2] ?? false;
  const methods: readonly CustomConnectorAuthMethod[] =
    connector.authMode === "oauth" && oauth2Enabled
      ? [{ type: "oauth2" }]
      : [{ type: "api" }];
  const selectedMethod =
    methods.find((method) => {
      return method.type === form.authMethod;
    }) ?? (methods.length === 1 ? methods[0] : undefined);
  const setField = useSet(setCustomConnectorConnectField$);
  const resetForm = useSet(resetCustomConnectorConnectInput$);
  const closeDialog = useSet(closeCustomConnectorDialog$);
  const { submitting, submitSecret, submitOAuth } =
    useCustomConnectorConnectionSubmitters(agentId);
  const signal = useGet(pageSignal$);

  const canSubmit =
    !submitting &&
    (selectedMethod?.type === "api"
      ? hasTokenInputValue(form.apiSecret)
      : selectedMethod?.type === "oauth2");

  const close = () => {
    resetForm();
    if (onClose) {
      onClose();
    } else {
      closeDialog();
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || !selectedMethod) {
      return;
    }
    detach(
      (async () => {
        if (selectedMethod.type === "api") {
          await submitSecret(
            { id: connector.id, value: form.apiSecret },
            signal,
          );
        } else {
          await submitOAuth(connector.id, signal);
        }
        close();
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        return !open && close();
      }}
    >
      <DialogContent className="max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <CustomConnectorIcon
              id={connector.id}
              displayName={connector.displayName}
              size={20}
            />
            <DialogTitle>
              {t(
                ($) => {
                  return $.connectors.custom.connect.title;
                },
                { connector: connector.displayName },
              )}
            </DialogTitle>
          </div>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.connectors.custom.connect.description;
          })}
        </p>
        <form className="flex flex-col gap-4" onSubmit={onSubmit}>
          <CredentialFields
            selectedMethod={selectedMethod}
            methods={methods}
            apiSecret={form.apiSecret}
            setField={setField}
          />
          <ConnectDialogFooter
            selectedMethod={selectedMethod}
            multipleMethods={methods.length > 1}
            submitting={submitting}
            canSubmit={canSubmit}
            onBack={() => {
              setField("authMethod", null);
            }}
            onClose={close}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}
