import type { FormEvent } from "react";

import { IconPlus, IconTrash } from "@tabler/icons-react";
import type {
  CreateCustomConnectorBody,
  CustomConnectorAuthMethod,
  CustomConnectorOAuth2AuthMethod,
  CustomConnectorResponse,
  UpdateCustomConnectorBody,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui";
import { Input } from "@vm0/ui/components/ui/input";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";

import { resolveApiBaseForTarget } from "../../../../signals/api-base.ts";
import { featureSwitch$ } from "../../../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  addCustomConnectorAuthMethod$,
  closeCustomConnectorDialog$,
  createCustomConnector$,
  customConnectorCreateForm$,
  openCustomConnectorEditConfirmationDialog$,
  removeCustomConnectorAuthMethod$,
  resetCustomConnectorCreateForm$,
  setCustomConnectorCreateField$,
  type CustomConnectorCreateForm,
  updateCustomConnector$,
} from "../../../../signals/zero-page/settings/custom-connectors.ts";
import { detach, Reason } from "../../../../signals/utils.ts";

type CreateField = Exclude<keyof CustomConnectorCreateForm, "authMethodTypes">;

interface CreateFormFieldProps {
  readonly form: CustomConnectorCreateForm;
  readonly setField: (field: CreateField, value: string) => void;
}

function parsePrefixLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => {
      return line.trim();
    })
    .filter((line) => {
      return line.length > 0;
    });
}

function parseScopes(raw: string): string[] {
  return raw
    .split(/\s+/u)
    .map((scope) => {
      return scope.trim();
    })
    .filter((scope) => {
      return scope.length > 0;
    });
}

function BaseFields({ form, setField }: CreateFormFieldProps) {
  const { t } = useTranslation();
  return (
    <>
      <div className="flex flex-col gap-2">
        <label
          htmlFor="cc-display-name"
          className="text-sm font-medium text-foreground"
        >
          {t(($) => {
            return $.connectors.custom.create.displayName;
          })}
        </label>
        <Input
          id="cc-display-name"
          value={form.displayName}
          onChange={(event) => {
            setField("displayName", event.target.value);
          }}
          placeholder="Acme API"
        />
      </div>
      <div className="flex flex-col gap-2">
        <label
          htmlFor="cc-prefixes"
          className="text-sm font-medium text-foreground"
        >
          {t(($) => {
            return $.connectors.custom.create.prefixes;
          })}
          <span className="text-muted-foreground font-normal ml-1">
            {t(($) => {
              return $.connectors.custom.create.prefixesHint;
            })}
          </span>
        </label>
        <textarea
          id="cc-prefixes"
          value={form.prefixesRaw}
          onChange={(event) => {
            setField("prefixesRaw", event.target.value);
          }}
          placeholder="https://api.acme.com/v1/"
          rows={3}
          className="w-full rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-primary focus:ring-[3px] focus:ring-primary/10 resize-y min-h-[72px]"
        />
      </div>
    </>
  );
}

function ApiAuthenticationFields({
  form,
  setField,
  removable,
  editable = true,
  onRemove,
}: CreateFormFieldProps & {
  readonly removable: boolean;
  readonly editable?: boolean;
  readonly onRemove?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border border-border p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-foreground">
            API authentication
          </p>
          <p className="text-xs text-muted-foreground">
            Inject a user-provided secret into every matching request.
          </p>
        </div>
        {removable && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Remove API authentication"
            onClick={onRemove}
          >
            <IconTrash size={16} />
          </Button>
        )}
      </div>
      {editable ? (
        <>
          <div className="flex flex-col gap-2">
            <label
              htmlFor="cc-header-name"
              className="text-sm font-medium text-foreground"
            >
              {t(($) => {
                return $.connectors.custom.create.headerName;
              })}
            </label>
            <Input
              id="cc-header-name"
              value={form.headerName}
              onChange={(event) => {
                setField("headerName", event.target.value);
              }}
              placeholder="Authorization"
            />
          </div>
          <div className="flex flex-col gap-2">
            <label
              htmlFor="cc-header-template"
              className="text-sm font-medium text-foreground"
            >
              {t(($) => {
                return $.connectors.custom.create.headerTemplate;
              })}
              <span className="text-muted-foreground font-normal ml-1">
                {t(
                  ($) => {
                    return $.connectors.custom.create.headerTemplateHint;
                  },
                  { placeholder: "{{secret}}" },
                )}
              </span>
            </label>
            <Input
              id="cc-header-template"
              value={form.headerTemplate}
              onChange={(event) => {
                setField("headerTemplate", event.target.value);
              }}
              placeholder="Bearer {{secret}}"
            />
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          Advanced API fields and injections are preserved when you save.
        </p>
      )}
    </div>
  );
}

function customConnectorOAuthCallbackUrl(): string {
  return new URL(
    "/connectors/custom/callback",
    resolveApiBaseForTarget("app"),
  ).toString();
}

function OAuth2ClientFields({
  form,
  setField,
  editing,
}: CreateFormFieldProps & { readonly editing: boolean }) {
  return (
    <>
      <div className="flex flex-col gap-2">
        <label
          htmlFor="cc-oauth-client-id"
          className="text-sm font-medium text-foreground"
        >
          {editing ? "New client ID" : "Client ID"}
        </label>
        <Input
          id="cc-oauth-client-id"
          value={form.oauthClientId}
          onChange={(event) => {
            setField("oauthClientId", event.target.value);
          }}
          placeholder={editing ? "Leave blank to keep current" : undefined}
        />
      </div>
      <div className="flex flex-col gap-2">
        <label
          htmlFor="cc-oauth-client-secret"
          className="text-sm font-medium text-foreground"
        >
          {editing ? "New client secret" : "Client secret"}
        </label>
        <Input
          id="cc-oauth-client-secret"
          type="password"
          value={form.oauthClientSecret}
          onChange={(event) => {
            setField("oauthClientSecret", event.target.value);
          }}
          placeholder={editing ? "Leave blank to keep current" : undefined}
        />
      </div>
      {editing && (
        <p className="text-xs text-muted-foreground">
          Leave both fields blank to keep the stored OAuth client credentials.
        </p>
      )}
    </>
  );
}

function OAuth2RedirectUrlField() {
  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor="cc-oauth-callback-url"
        className="text-sm font-medium text-foreground"
      >
        Redirect URL
      </label>
      <Input
        id="cc-oauth-callback-url"
        value={customConnectorOAuthCallbackUrl()}
        readOnly
        className="font-mono text-xs"
      />
      <p className="text-xs text-muted-foreground">
        Register this URL in the provider&apos;s OAuth application.
      </p>
    </div>
  );
}

function OAuth2AuthenticationFields({
  form,
  setField,
  editing,
  onRemove,
}: CreateFormFieldProps & {
  readonly editing: boolean;
  readonly onRemove: () => void;
}) {
  return (
    <div className="rounded-xl border border-border p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-foreground">OAuth 2.0</p>
          <p className="text-xs text-muted-foreground">
            Configure one OAuth app for members to authorize.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Remove OAuth 2.0"
          onClick={onRemove}
        >
          <IconTrash size={16} />
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        <label
          htmlFor="cc-oauth-authorization-url"
          className="text-sm font-medium text-foreground"
        >
          Authorization URL
        </label>
        <Input
          id="cc-oauth-authorization-url"
          value={form.oauthAuthorizationUrl}
          onChange={(event) => {
            setField("oauthAuthorizationUrl", event.target.value);
          }}
          placeholder="https://provider.example.com/oauth/authorize"
        />
      </div>
      <div className="flex flex-col gap-2">
        <label
          htmlFor="cc-oauth-token-url"
          className="text-sm font-medium text-foreground"
        >
          Token URL
        </label>
        <Input
          id="cc-oauth-token-url"
          value={form.oauthTokenUrl}
          onChange={(event) => {
            setField("oauthTokenUrl", event.target.value);
          }}
          placeholder="https://provider.example.com/oauth/token"
        />
      </div>
      <OAuth2ClientFields form={form} setField={setField} editing={editing} />
      <div className="flex flex-col gap-2">
        <label
          htmlFor="cc-oauth-scopes"
          className="text-sm font-medium text-foreground"
        >
          Scopes
          <span className="text-muted-foreground font-normal ml-1">
            (space separated)
          </span>
        </label>
        <Input
          id="cc-oauth-scopes"
          value={form.oauthScopesRaw}
          onChange={(event) => {
            setField("oauthScopesRaw", event.target.value);
          }}
          placeholder="read write"
        />
      </div>
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-foreground">
          Token endpoint authentication
        </label>
        <Select
          value={form.oauthClientAuthentication}
          onValueChange={(value) => {
            setField("oauthClientAuthentication", value);
          }}
        >
          <SelectTrigger aria-label="Token endpoint authentication">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="client_secret_post">
              Client secret in request body
            </SelectItem>
            <SelectItem value="client_secret_basic">
              HTTP Basic authentication
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <OAuth2RedirectUrlField />
      {editing && (
        <p className="text-xs text-muted-foreground">
          Changing OAuth settings or client credentials disconnects existing
          OAuth connections.
        </p>
      )}
    </div>
  );
}

function LegacyApiFields(props: CreateFormFieldProps) {
  return <ApiAuthenticationFields {...props} removable={false} />;
}

function connectorAuthMethods(
  connector: CustomConnectorResponse,
): readonly CustomConnectorAuthMethod[] {
  return connector.authMethods ?? [{ type: "api" }];
}

function connectorHasSimpleApiDefinition(
  connector: CustomConnectorResponse,
): boolean {
  const supportsApi = connectorAuthMethods(connector).some((method) => {
    return method.type === "api";
  });
  const field = connector.fields[0];
  const injection = connector.headerInjections[0];
  return (
    supportsApi &&
    connector.fields.length === 1 &&
    field?.key === "secret" &&
    field.kind === "secret" &&
    field.required &&
    connector.headerInjections.length === 1 &&
    injection?.valueTemplate.includes("{{secrets.secret}}") === true &&
    connector.queryInjections.length === 0
  );
}

function authMethodsFromForm(
  form: CustomConnectorCreateForm,
): CustomConnectorAuthMethod[] {
  return form.authMethodTypes.map((type) => {
    return type === "api"
      ? { type }
      : {
          type,
          authorizationUrl: form.oauthAuthorizationUrl.trim(),
          tokenUrl: form.oauthTokenUrl.trim(),
          scopes: parseScopes(form.oauthScopesRaw),
          clientAuthentication: form.oauthClientAuthentication,
        };
  });
}

function canonicalDefinitionFromForm(
  form: CustomConnectorCreateForm,
  connector?: CustomConnectorResponse,
): UpdateCustomConnectorBody {
  const supportsApi = form.authMethodTypes.includes("api");
  const preserveAdvancedApiDefinition =
    connector !== undefined &&
    connectorAuthMethods(connector).some((method) => {
      return method.type === "api";
    }) &&
    !connectorHasSimpleApiDefinition(connector);
  return {
    displayName: form.displayName.trim(),
    prefixTemplates: parsePrefixLines(form.prefixesRaw),
    fields: supportsApi
      ? preserveAdvancedApiDefinition
        ? (connector?.fields ?? [])
        : [
            {
              key: "secret",
              label: "Secret",
              kind: "secret",
              required: true,
              description: "API credential",
            },
          ]
      : [],
    headerInjections: supportsApi
      ? preserveAdvancedApiDefinition
        ? (connector?.headerInjections ?? [])
        : [
            {
              name: form.headerName.trim(),
              valueTemplate: form.headerTemplate.replaceAll(
                "{{secret}}",
                "{{secrets.secret}}",
              ),
            },
          ]
      : [],
    queryInjections:
      supportsApi && preserveAdvancedApiDefinition
        ? (connector?.queryInjections ?? [])
        : [],
    authMethods: authMethodsFromForm(form),
  };
}

function buildCreateBody(
  form: CustomConnectorCreateForm,
  oauth2Enabled: boolean,
): CreateCustomConnectorBody {
  const prefixTemplates = parsePrefixLines(form.prefixesRaw);
  if (!oauth2Enabled) {
    return {
      displayName: form.displayName.trim(),
      prefixes: prefixTemplates,
      headerName: form.headerName.trim(),
      headerTemplate: form.headerTemplate,
    };
  }
  const definition = canonicalDefinitionFromForm(form);
  const supportsOAuth2 = form.authMethodTypes.includes("oauth2");
  return {
    ...definition,
    ...(supportsOAuth2
      ? {
          oauthClientId: form.oauthClientId.trim(),
          oauthClientSecret: form.oauthClientSecret,
        }
      : {}),
  };
}

function buildUpdateBody(
  form: CustomConnectorCreateForm,
  connector: CustomConnectorResponse,
): UpdateCustomConnectorBody {
  const definition = canonicalDefinitionFromForm(form, connector);
  const replacingOAuthCredentials =
    form.authMethodTypes.includes("oauth2") &&
    form.oauthClientId.trim().length > 0 &&
    form.oauthClientSecret.trim().length > 0;
  return {
    ...definition,
    ...(replacingOAuthCredentials
      ? {
          oauthClientId: form.oauthClientId.trim(),
          oauthClientSecret: form.oauthClientSecret,
        }
      : {}),
  };
}

function oauth2Method(
  authMethods: readonly CustomConnectorAuthMethod[],
): CustomConnectorOAuth2AuthMethod | null {
  return (
    authMethods.find((method): method is CustomConnectorOAuth2AuthMethod => {
      return method.type === "oauth2";
    }) ?? null
  );
}

function oauth2MethodsEqual(
  left: CustomConnectorOAuth2AuthMethod | null,
  right: CustomConnectorOAuth2AuthMethod | null,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return (
    left.authorizationUrl === right.authorizationUrl &&
    left.tokenUrl === right.tokenUrl &&
    left.clientAuthentication === right.clientAuthentication &&
    left.scopes.length === right.scopes.length &&
    left.scopes.every((scope, index) => {
      return scope === right.scopes[index];
    })
  );
}

function updateDisconnectsOAuthConnections(
  connector: CustomConnectorResponse,
  body: UpdateCustomConnectorBody,
): boolean {
  const existingOAuthMethod = oauth2Method(connectorAuthMethods(connector));
  if (!existingOAuthMethod) {
    return false;
  }
  if (
    body.oauthClientId !== undefined ||
    body.oauthClientSecret !== undefined
  ) {
    return true;
  }
  return !oauth2MethodsEqual(
    existingOAuthMethod,
    oauth2Method(body.authMethods ?? connectorAuthMethods(connector)),
  );
}

function oauthCredentialsCanSubmit(
  form: CustomConnectorCreateForm,
  connector?: CustomConnectorResponse,
): boolean {
  const existingOAuthMethod = connector
    ? connectorAuthMethods(connector).find((method) => {
        return method.type === "oauth2";
      })
    : undefined;
  const credentialsRequired =
    !existingOAuthMethod ||
    (existingOAuthMethod.type === "oauth2" &&
      existingOAuthMethod.clientAuthentication !==
        form.oauthClientAuthentication);
  const hasClientId = form.oauthClientId.trim().length > 0;
  const hasClientSecret = form.oauthClientSecret.trim().length > 0;
  return credentialsRequired
    ? hasClientId && hasClientSecret
    : hasClientId === hasClientSecret;
}

function formCanSubmit(
  form: CustomConnectorCreateForm,
  oauth2Enabled: boolean,
  connector?: CustomConnectorResponse,
): boolean {
  if (
    form.displayName.trim().length === 0 ||
    parsePrefixLines(form.prefixesRaw).length === 0
  ) {
    return false;
  }
  if (!oauth2Enabled && !connector) {
    return (
      form.headerName.trim().length > 0 &&
      form.headerTemplate.includes("{{secret}}")
    );
  }
  if (form.authMethodTypes.length === 0) {
    return false;
  }
  const advancedApiDefinition =
    connector !== undefined &&
    connectorAuthMethods(connector).some((method) => {
      return method.type === "api";
    }) &&
    !connectorHasSimpleApiDefinition(connector);
  if (
    form.authMethodTypes.includes("api") &&
    !advancedApiDefinition &&
    (form.headerName.trim().length === 0 ||
      !form.headerTemplate.includes("{{secret}}"))
  ) {
    return false;
  }
  if (!form.authMethodTypes.includes("oauth2")) {
    return true;
  }
  if (
    form.oauthAuthorizationUrl.trim().length === 0 ||
    form.oauthTokenUrl.trim().length === 0
  ) {
    return false;
  }
  return oauthCredentialsCanSubmit(form, connector);
}

interface AuthenticationFieldsProps extends CreateFormFieldProps {
  readonly oauth2Enabled: boolean;
  readonly editing: boolean;
  readonly advancedApiDefinition: boolean;
  readonly addAuthMethod: (type: CustomConnectorAuthMethod["type"]) => void;
  readonly removeAuthMethod: (type: CustomConnectorAuthMethod["type"]) => void;
}

function AuthenticationFields({
  form,
  setField,
  oauth2Enabled,
  editing,
  advancedApiDefinition,
  addAuthMethod,
  removeAuthMethod,
}: AuthenticationFieldsProps) {
  if (!oauth2Enabled && !editing) {
    return <LegacyApiFields form={form} setField={setField} />;
  }
  const availableAuthMethods = (
    oauth2Enabled ? (["api", "oauth2"] as const) : (["api"] as const)
  ).filter((type) => {
    return !form.authMethodTypes.includes(type);
  });
  return (
    <>
      {form.authMethodTypes.includes("api") && (
        <ApiAuthenticationFields
          form={form}
          setField={setField}
          removable
          editable={!advancedApiDefinition}
          onRemove={() => {
            removeAuthMethod("api");
          }}
        />
      )}
      {form.authMethodTypes.includes("oauth2") && (
        <OAuth2AuthenticationFields
          form={form}
          setField={setField}
          editing={editing}
          onRemove={() => {
            removeAuthMethod("oauth2");
          }}
        />
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="self-start"
            disabled={availableAuthMethods.length === 0}
          >
            <IconPlus size={16} />
            Add authentication
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {availableAuthMethods.includes("api") && (
            <DropdownMenuItem
              onClick={() => {
                addAuthMethod("api");
              }}
            >
              API authentication
            </DropdownMenuItem>
          )}
          {availableAuthMethods.includes("oauth2") && (
            <DropdownMenuItem
              onClick={() => {
                addAuthMethod("oauth2");
              }}
            >
              OAuth 2.0
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

export function CustomConnectorCreateDialog({
  connector,
}: {
  readonly connector?: CustomConnectorResponse;
}) {
  const { t } = useTranslation();
  const form = useGet(customConnectorCreateForm$);
  const featureSwitches = useGet(featureSwitch$);
  const oauth2Enabled =
    featureSwitches[FeatureSwitchKey.CustomConnectorOAuth2] ?? false;
  const setField = useSet(setCustomConnectorCreateField$);
  const addAuthMethod = useSet(addCustomConnectorAuthMethod$);
  const removeAuthMethod = useSet(removeCustomConnectorAuthMethod$);
  const openEditConfirmation = useSet(
    openCustomConnectorEditConfirmationDialog$,
  );
  const closeDialog = useSet(closeCustomConnectorDialog$);
  const resetForm = useSet(resetCustomConnectorCreateForm$);
  const [createLoadable, createConnector] = useLoadableSet(
    createCustomConnector$,
  );
  const [updateLoadable, updateConnector] = useLoadableSet(
    updateCustomConnector$,
  );
  const signal = useGet(pageSignal$);

  const editing = connector !== undefined;
  const submitting = editing
    ? updateLoadable.state === "loading"
    : createLoadable.state === "loading";
  const canSubmit =
    !submitting && formCanSubmit(form, oauth2Enabled, connector);
  const advancedApiDefinition =
    connector !== undefined &&
    connectorAuthMethods(connector).some((method) => {
      return method.type === "api";
    }) &&
    !connectorHasSimpleApiDefinition(connector);

  const close = () => {
    resetForm();
    closeDialog();
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    detach(
      (async () => {
        if (connector) {
          const body = buildUpdateBody(form, connector);
          if (updateDisconnectsOAuthConnections(connector, body)) {
            openEditConfirmation({ connector, body });
            return;
          }
          await updateConnector(
            {
              id: connector.id,
              body,
            },
            signal,
          );
        } else {
          await createConnector(buildCreateBody(form, oauth2Enabled), signal);
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
        className="max-w-2xl max-h-[90vh] overflow-y-auto"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>
            {editing
              ? t(($) => {
                  return $.connectors.custom.edit.title;
                })
              : t(($) => {
                  return $.connectors.custom.create.title;
                })}
          </DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={onSubmit}>
          <BaseFields form={form} setField={setField} />
          <AuthenticationFields
            form={form}
            setField={setField}
            oauth2Enabled={oauth2Enabled}
            editing={editing}
            advancedApiDefinition={advancedApiDefinition}
            addAuthMethod={addAuthMethod}
            removeAuthMethod={removeAuthMethod}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={close}
              disabled={submitting}
            >
              {t(($) => {
                return $.connectors.actions.cancel;
              })}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting
                ? t(($) => {
                    return editing
                      ? $.connectors.actions.savingEllipsis
                      : $.connectors.actions.creating;
                  })
                : t(($) => {
                    return editing
                      ? $.connectors.actions.save
                      : $.connectors.actions.create;
                  })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
