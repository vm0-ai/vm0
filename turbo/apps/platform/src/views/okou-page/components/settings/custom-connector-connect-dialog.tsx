import type { FormEvent } from "react";

import type {
  CustomConnectorResponse,
  CustomConnectorValueInput,
} from "@okouai/api-contracts/contracts/custom-connectors";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui";
import { Input } from "@okouai/ui/components/ui/input";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";

import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  closeCustomConnectorDialog$,
  connectCustomConnectorOAuth2$,
  connectCustomConnectorAccountOAuth2$,
  connectCustomConnectorOAuth2ForAgent$,
  customConnectorConnectForm$,
  resetCustomConnectorConnectInput$,
  setCustomConnectorConnectField$,
  setCustomConnectorValues$,
  setCustomConnectorAccountValues$,
  setCustomConnectorValuesForAgent$,
} from "../../../../signals/okou-page/settings/custom-connectors.ts";
import { sanitizeTokenInputRecord } from "../../../../signals/okou-page/settings/token-input.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { CustomConnectorIcon } from "./custom-connector-icon.tsx";
import type {
  ConnectorAccountConnectMode,
  ConnectorAccountMutationOptions,
} from "../../../../signals/okou-page/settings/connector-account-dialogs.ts";

interface CustomConnectorConnectionSubmission {
  readonly connected: boolean;
  readonly targetAuthorized: boolean;
  readonly connectionId: string | null;
}

function formValue(
  values: Readonly<Record<string, string>>,
  key: string,
): string {
  return Object.hasOwn(values, key) ? values[key] : "";
}

function declaredValuesFromForm(
  connector: CustomConnectorResponse,
  values: Readonly<Record<string, string>>,
): readonly CustomConnectorValueInput[] {
  const variableKeys = new Set(
    connector.fields.flatMap((field) => {
      return field.kind === "variable" ? [field.key] : [];
    }),
  );
  const normalized = sanitizeTokenInputRecord(
    { ...values },
    { preserveWhitespaceKeys: variableKeys },
  );

  return connector.fields.flatMap((field): CustomConnectorValueInput[] => {
    const value = formValue(normalized, field.key);
    return value.length > 0
      ? [{ key: field.key, kind: field.kind, value }]
      : [];
  });
}

function CredentialFields({
  connector,
  configuredFieldKeys,
  values,
  setField,
}: {
  readonly connector: CustomConnectorResponse;
  readonly configuredFieldKeys: readonly string[];
  readonly values: Readonly<Record<string, string>>;
  readonly setField: (args: {
    readonly key: string;
    readonly value: string;
  }) => void;
}) {
  const { t } = useTranslation();
  const configuredKeys = new Set(configuredFieldKeys);
  return connector.fields.map((field, index) => {
    const inputId = `cc-connect-field-${index}`;
    const statusId = `${inputId}-status`;
    const descriptionId = field.description
      ? `${inputId}-description`
      : undefined;
    const configured = configuredKeys.has(field.key);
    const status = field.required
      ? t(($) => {
          return $.connectors.card.required;
        })
      : t(($) => {
          return $.connectors.card.optional;
        });
    const configuredStatus = configured
      ? t(($) => {
          return $.connectors.custom.connect.configured;
        })
      : null;

    return (
      <div key={field.key} className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <label
            htmlFor={inputId}
            className="text-sm font-medium text-foreground"
          >
            {field.label}
          </label>
          <span id={statusId} className="text-xs text-muted-foreground">
            {status}
            {configuredStatus ? ` · ${configuredStatus}` : ""}
          </span>
        </div>
        {field.description && (
          <p id={descriptionId} className="text-xs text-muted-foreground">
            {field.description}
          </p>
        )}
        <Input
          id={inputId}
          name={`custom-connector-${connector.id}-${field.key}`}
          type={field.kind === "secret" ? "password" : "text"}
          value={formValue(values, field.key)}
          onChange={(event) => {
            setField({ key: field.key, value: event.target.value });
          }}
          autoComplete={field.kind === "secret" ? "new-password" : "off"}
          aria-describedby={
            descriptionId ? `${descriptionId} ${statusId}` : statusId
          }
          autoFocus={index === 0}
        />
      </div>
    );
  });
}

function useCustomConnectorConnectionSubmitters(
  agentId: string | undefined,
  accountOptions: ConnectorAccountMutationOptions,
) {
  const [valuesLoadable, submitValues] = useLoadableSet(
    setCustomConnectorValues$,
  );
  const [agentValuesLoadable, submitAgentValues] = useLoadableSet(
    setCustomConnectorValuesForAgent$,
  );
  const [oauthLoadable, submitOAuth2] = useLoadableSet(
    connectCustomConnectorOAuth2$,
  );
  const [agentOAuthLoadable, submitAgentOAuth2] = useLoadableSet(
    connectCustomConnectorOAuth2ForAgent$,
  );
  const [accountValuesLoadable, submitAccountValues] = useLoadableSet(
    setCustomConnectorAccountValues$,
  );
  const [accountOAuthLoadable, submitAccountOAuth2] = useLoadableSet(
    connectCustomConnectorAccountOAuth2$,
  );
  const account = accountOptions.account;
  const usesDefaultProjection =
    accountOptions.useDefaultConnectorProjection === true;
  const managesAccount = !usesDefaultProjection;

  const submitDeclaredValues = async (
    args: {
      readonly id: string;
      readonly values: readonly CustomConnectorValueInput[];
    },
    signal: AbortSignal,
  ): Promise<CustomConnectorConnectionSubmission> => {
    if (managesAccount) {
      return await submitAccountValues({ ...args, account }, signal);
    }
    if (agentId) {
      return await submitAgentValues({ ...args, agentId, account }, signal);
    }
    return await submitValues({ ...args, account }, signal);
  };
  const submitOAuth = async (
    connectorId: string,
    signal: AbortSignal,
  ): Promise<CustomConnectorConnectionSubmission> => {
    if (managesAccount) {
      return await submitAccountOAuth2({ id: connectorId, account }, signal);
    }
    if (agentId) {
      return await submitAgentOAuth2(
        {
          id: connectorId,
          agentId,
          account,
          ...(usesDefaultProjection
            ? { useDefaultConnectorProjection: true as const }
            : {}),
        },
        signal,
      );
    }
    return await submitOAuth2(
      {
        id: connectorId,
        account,
        ...(usesDefaultProjection
          ? { useDefaultConnectorProjection: true as const }
          : {}),
      },
      signal,
    );
  };

  return {
    submitting:
      valuesLoadable.state === "loading" ||
      agentValuesLoadable.state === "loading" ||
      oauthLoadable.state === "loading" ||
      agentOAuthLoadable.state === "loading" ||
      accountValuesLoadable.state === "loading" ||
      accountOAuthLoadable.state === "loading",
    submitDeclaredValues,
    submitOAuth,
  };
}

function ConnectDialogFooter({
  oauth,
  submitting,
  canSubmit,
  onClose,
}: {
  readonly oauth: boolean;
  readonly submitting: boolean;
  readonly canSubmit: boolean;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const submitLabel = oauth
    ? submitting
      ? t(($) => {
          return $.connectors.custom.connect.connecting;
        })
      : t(($) => {
          return $.connectors.custom.connect.continue;
        })
    : submitting
      ? t(($) => {
          return $.connectors.custom.connect.saving;
        })
      : t(($) => {
          return $.connectors.custom.connect.save;
        });
  return (
    <DialogFooter>
      <Button
        type="button"
        variant="outline"
        onClick={onClose}
        disabled={submitting}
      >
        {t(($) => {
          return $.connectors.actions.cancel;
        })}
      </Button>
      <Button type="submit" disabled={!canSubmit}>
        {submitLabel}
      </Button>
    </DialogFooter>
  );
}

interface CustomConnectorConnectDialogProps {
  readonly connector: CustomConnectorResponse;
  readonly agentId?: string;
  readonly onClose?: () => void;
  readonly onSuccess?: (connectionId: string | null) => void | Promise<void>;
  readonly accountOptions: ConnectorAccountMutationOptions;
  readonly accountMode?: ConnectorAccountConnectMode;
}

function CustomConnectorConnectForm({
  connector,
  accountMode,
  values,
  setField,
  submitting,
  canSubmit,
  close,
  onSubmit,
}: {
  readonly connector: CustomConnectorResponse;
  readonly accountMode: ConnectorAccountConnectMode | undefined;
  readonly values: Readonly<Record<string, string>>;
  readonly setField: (args: {
    readonly key: string;
    readonly value: string;
  }) => void;
  readonly submitting: boolean;
  readonly canSubmit: boolean;
  readonly close: () => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const { t } = useTranslation();
  const oauth = connector.authMode === "oauth";
  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      {oauth ? (
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.connectors.custom.connect.continueToProvider;
          })}
        </p>
      ) : (
        <CredentialFields
          connector={connector}
          configuredFieldKeys={accountMode ? [] : connector.configuredFieldKeys}
          values={values}
          setField={setField}
        />
      )}
      <ConnectDialogFooter
        oauth={oauth}
        submitting={submitting}
        canSubmit={canSubmit}
        onClose={close}
      />
    </form>
  );
}

export function CustomConnectorConnectDialog({
  connector,
  agentId,
  onClose,
  onSuccess,
  accountOptions,
  accountMode,
}: CustomConnectorConnectDialogProps) {
  const { t } = useTranslation();
  const form = useGet(customConnectorConnectForm$);
  const setField = useSet(setCustomConnectorConnectField$);
  const resetForm = useSet(resetCustomConnectorConnectInput$);
  const closeDialog = useSet(closeCustomConnectorDialog$);
  const { submitting, submitDeclaredValues, submitOAuth } =
    useCustomConnectorConnectionSubmitters(agentId, accountOptions);
  const signal = useGet(pageSignal$);
  const oauth = connector.authMode === "oauth";
  const values = declaredValuesFromForm(connector, form.values);
  const submittedKeys = new Set(
    values.map((value) => {
      return value.key;
    }),
  );
  const requiredFieldKeys =
    accountMode?.kind === "add"
      ? connector.fields.flatMap((field) => {
          return field.required ? [field.key] : [];
        })
      : connector.missingRequiredFields;
  const hasRequiredValues = requiredFieldKeys.every((key) => {
    return submittedKeys.has(key);
  });
  const canSubmit =
    !submitting && (oauth || (values.length > 0 && hasRequiredValues));
  const showSecretDescription =
    !oauth &&
    connector.fields.length === 1 &&
    connector.fields[0]?.kind === "secret";

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
    if (!canSubmit) {
      return;
    }
    detach(
      (async () => {
        const result = oauth
          ? await submitOAuth(connector.id, signal)
          : await submitDeclaredValues({ id: connector.id, values }, signal);
        if (!result.connected) {
          return;
        }
        if (result.targetAuthorized || accountMode) {
          await onSuccess?.(result.connectionId);
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
      <DialogContent
        className="max-w-md"
        aria-describedby={undefined}
        closeLabel={t(($) => {
          return $.connectors.actions.close;
        })}
      >
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
        {showSecretDescription && (
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return $.connectors.custom.connect.description;
            })}
          </p>
        )}
        <CustomConnectorConnectForm
          connector={connector}
          accountMode={accountMode}
          values={form.values}
          setField={setField}
          submitting={submitting}
          canSubmit={canSubmit}
          close={close}
          onSubmit={onSubmit}
        />
      </DialogContent>
    </Dialog>
  );
}
