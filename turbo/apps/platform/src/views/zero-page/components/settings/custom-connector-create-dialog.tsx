import type { FormEvent } from "react";

import { IconPlus, IconTrash } from "@tabler/icons-react";
import type {
  CreateCustomConnectorBody,
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
  closeCustomConnectorEditConfirmationDialog$,
  closeCustomConnectorDialog$,
  createCustomConnector$,
  customConnectorCreateForm$,
  customConnectorEditConfirmation$,
  openCustomConnectorEditConfirmationDialog$,
  removeCustomConnectorAuthMethod$,
  resetCustomConnectorCreateForm$,
  setCustomConnectorCreateField$,
  type CustomConnectorAuthMethodType,
  type CustomConnectorCreateForm,
  updateCustomConnector$,
} from "../../../../signals/zero-page/settings/custom-connectors.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { CustomConnectorUpdateConfirm } from "./custom-connector-update-confirm.tsx";

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

const OAUTH_AUTHORIZATION_PARAM_FIELDS = [
  {
    field: "oauthResource",
    label: "Resource",
    placeholder: "https://api.provider.example",
  },
  {
    field: "oauthAudience",
    label: "Audience",
    placeholder: "https://api.provider.example",
  },
  {
    field: "oauthAccessType",
    label: "Access type",
    placeholder: "offline",
  },
  {
    field: "oauthPrompt",
    label: "Prompt",
    placeholder: "consent",
  },
] as const satisfies readonly {
  readonly field: CreateField;
  readonly label: string;
  readonly placeholder: string;
}[];

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
          Client ID
        </label>
        <Input
          id="cc-oauth-client-id"
          value={form.oauthClientId}
          onChange={(event) => {
            setField("oauthClientId", event.target.value);
          }}
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
          Leave the client secret blank to keep the stored value.
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
        <span className="ml-1 font-normal text-amber-600 dark:text-amber-400">
          (Register this URL in the provider&apos;s OAuth application.)
        </span>
      </label>
      <Input
        id="cc-oauth-callback-url"
        value={customConnectorOAuthCallbackUrl()}
        readOnly
        className="font-mono text-xs"
      />
    </div>
  );
}

function OAuth2AdvancedFields({ form, setField }: CreateFormFieldProps) {
  return (
    <>
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-foreground">PKCE</label>
        <Select
          value={form.oauthPkceMethod}
          onValueChange={(value) => {
            setField("oauthPkceMethod", value);
          }}
        >
          <SelectTrigger aria-label="PKCE">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            <SelectItem value="S256">S256</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <div>
          <p className="text-sm font-medium text-foreground">
            Authorization parameters
          </p>
          <p className="text-xs text-muted-foreground">
            Add only the parameters your provider requires.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {OAUTH_AUTHORIZATION_PARAM_FIELDS.map((parameter) => {
            return (
              <div key={parameter.field} className="flex flex-col gap-2">
                <label
                  htmlFor={`cc-${parameter.field}`}
                  className="text-sm font-medium text-foreground"
                >
                  {parameter.label}
                  <span className="text-muted-foreground font-normal ml-1">
                    (optional)
                  </span>
                </label>
                <Input
                  id={`cc-${parameter.field}`}
                  value={form[parameter.field]}
                  onChange={(event) => {
                    setField(parameter.field, event.target.value);
                  }}
                  placeholder={parameter.placeholder}
                />
              </div>
            );
          })}
        </div>
      </div>
    </>
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
            (one per line)
          </span>
        </label>
        <textarea
          id="cc-oauth-scopes"
          value={form.oauthScopesRaw}
          onChange={(event) => {
            setField("oauthScopesRaw", event.target.value);
          }}
          placeholder={"read\nwrite"}
          rows={3}
          className="w-full rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-primary focus:ring-[3px] focus:ring-primary/10 resize-y min-h-[72px]"
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
      <OAuth2AdvancedFields form={form} setField={setField} />
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

function connectorHasSimpleApiDefinition(
  connector: CustomConnectorResponse,
): boolean {
  const field = connector.fields[0];
  const injection = connector.headerInjections[0];
  return (
    (connector.authMode ?? "manual") === "manual" &&
    connector.fields.length === 1 &&
    field?.key === "secret" &&
    field.kind === "secret" &&
    field.required &&
    connector.headerInjections.length === 1 &&
    injection?.valueTemplate.includes("{{secrets.secret}}") === true &&
    connector.queryInjections.length === 0
  );
}

interface CustomConnectorDefinitionParts {
  readonly fields: CustomConnectorResponse["fields"];
  readonly headerInjections: CustomConnectorResponse["headerInjections"];
  readonly queryInjections: CustomConnectorResponse["queryInjections"];
}

function manualDefinitionFromForm(
  form: CustomConnectorCreateForm,
  connector?: CustomConnectorResponse,
): CustomConnectorDefinitionParts {
  const preserveAdvancedDefinition =
    connector !== undefined &&
    (connector.authMode ?? "manual") === "manual" &&
    !connectorHasSimpleApiDefinition(connector);
  if (preserveAdvancedDefinition) {
    return {
      fields: connector.fields,
      headerInjections: connector.headerInjections,
      queryInjections: connector.queryInjections,
    };
  }
  return {
    fields: [
      {
        key: "secret",
        label: "Secret",
        kind: "secret",
        required: true,
        description: "API credential",
      },
    ],
    headerInjections: [
      {
        name: form.headerName.trim(),
        valueTemplate: form.headerTemplate.replaceAll(
          "{{secret}}",
          "{{secrets.secret}}",
        ),
      },
    ],
    queryInjections: [],
  };
}

function oauthDefinitionFromConnector(
  connector?: CustomConnectorResponse,
): CustomConnectorDefinitionParts {
  if (connector?.authMode === "oauth") {
    return {
      fields: connector.fields,
      headerInjections: connector.headerInjections,
      queryInjections: connector.queryInjections,
    };
  }
  return {
    fields: [],
    headerInjections: [
      {
        name: "Authorization",
        valueTemplate: "Bearer {{oauth.access_token}}",
      },
    ],
    queryInjections: [],
  };
}

function oauthAuthorizationParamsFromForm(
  form: CustomConnectorCreateForm,
  connector?: CustomConnectorResponse,
): Readonly<Record<string, string>> {
  const authorizationParams = {
    ...connector?.oauthConfig?.authorizationParams,
  };
  const formParams = [
    ["resource", form.oauthResource],
    ["audience", form.oauthAudience],
    ["access_type", form.oauthAccessType],
    ["prompt", form.oauthPrompt],
  ] as const;
  for (const [name, rawValue] of formParams) {
    const value = rawValue.trim();
    if (value) {
      authorizationParams[name] = value;
    } else {
      delete authorizationParams[name];
    }
  }
  return authorizationParams;
}

function oauthConfigFromForm(
  form: CustomConnectorCreateForm,
  connector?: CustomConnectorResponse,
): NonNullable<UpdateCustomConnectorBody["oauthConfig"]> {
  return {
    providerAdapter: connector?.oauthConfig?.providerAdapter ?? "standard",
    clientId: form.oauthClientId.trim(),
    authorizationUrl: form.oauthAuthorizationUrl.trim(),
    tokenUrl: form.oauthTokenUrl.trim(),
    tokenEndpointAuthMethod: form.oauthClientAuthentication,
    pkceMethod: form.oauthPkceMethod,
    scopes: parseScopes(form.oauthScopesRaw),
    authorizationParams: oauthAuthorizationParamsFromForm(form, connector),
    ...(form.oauthClientSecret.trim().length > 0
      ? { clientSecret: form.oauthClientSecret }
      : {}),
  };
}

function canonicalDefinitionFromForm(
  form: CustomConnectorCreateForm,
  connector?: CustomConnectorResponse,
): UpdateCustomConnectorBody {
  const authMode = form.authMethodTypes.includes("oauth2")
    ? ("oauth" as const)
    : ("manual" as const);
  const definition =
    authMode === "manual"
      ? manualDefinitionFromForm(form, connector)
      : oauthDefinitionFromConnector(connector);
  return {
    displayName: form.displayName.trim(),
    prefixTemplates: parsePrefixLines(form.prefixesRaw),
    ...definition,
    authMode,
    ...(authMode === "oauth"
      ? { oauthConfig: oauthConfigFromForm(form, connector) }
      : {}),
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
  return definition;
}

function buildUpdateBody(
  form: CustomConnectorCreateForm,
  connector: CustomConnectorResponse,
): UpdateCustomConnectorBody {
  return canonicalDefinitionFromForm(form, connector);
}

function updateDisconnectsOAuthConnections(
  connector: CustomConnectorResponse,
  body: UpdateCustomConnectorBody,
): boolean {
  if (connector.authMode !== "oauth") {
    return false;
  }
  if (body.authMode !== "oauth" || !body.oauthConfig) {
    return true;
  }
  const existing = connector.oauthConfig;
  return (
    body.oauthConfig.clientSecret !== undefined ||
    !existing ||
    existing.clientId !== body.oauthConfig.clientId ||
    existing.authorizationUrl !== body.oauthConfig.authorizationUrl ||
    existing.tokenUrl !== body.oauthConfig.tokenUrl ||
    existing.tokenEndpointAuthMethod !==
      body.oauthConfig.tokenEndpointAuthMethod ||
    existing.pkceMethod !== body.oauthConfig.pkceMethod ||
    existing.scopes.join("\n") !== body.oauthConfig.scopes.join("\n") ||
    JSON.stringify(existing.authorizationParams) !==
      JSON.stringify(body.oauthConfig.authorizationParams)
  );
}

function oauthCredentialsCanSubmit(
  form: CustomConnectorCreateForm,
  connector?: CustomConnectorResponse,
): boolean {
  const credentialsRequired = !connector?.oauthConfig;
  const hasClientId = form.oauthClientId.trim().length > 0;
  const hasClientSecret = form.oauthClientSecret.trim().length > 0;
  return hasClientId && (!credentialsRequired || hasClientSecret);
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
    (connector.authMode ?? "manual") === "manual" &&
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
  readonly addAuthMethod: (type: CustomConnectorAuthMethodType) => void;
  readonly removeAuthMethod: (type: CustomConnectorAuthMethodType) => void;
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

function CustomConnectorForm({
  form,
  setField,
  oauth2Enabled,
  editing,
  advancedApiDefinition,
  addAuthMethod,
  removeAuthMethod,
  submitting,
  canSubmit,
  onSubmit,
  onCancel,
}: AuthenticationFieldsProps & {
  readonly submitting: boolean;
  readonly canSubmit: boolean;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
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
          onClick={onCancel}
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
  const closeEditConfirmation = useSet(
    closeCustomConnectorEditConfirmationDialog$,
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
  const pendingUpdate = useGet(customConnectorEditConfirmation$);

  const editing = connector !== undefined;
  const submitting = editing
    ? updateLoadable.state === "loading"
    : createLoadable.state === "loading";
  const canSubmit =
    !submitting && formCanSubmit(form, oauth2Enabled, connector);
  const advancedApiDefinition =
    connector !== undefined &&
    (connector.authMode ?? "manual") === "manual" &&
    !connectorHasSimpleApiDefinition(connector);

  const close = () => {
    resetForm();
    closeDialog();
  };

  const saveUpdate = (body: UpdateCustomConnectorBody) => {
    if (!connector) {
      return;
    }
    detach(
      (async () => {
        await updateConnector(
          {
            id: connector.id,
            body,
          },
          signal,
        );
        close();
      })(),
      Reason.DomCallback,
    );
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    if (connector) {
      const body = buildUpdateBody(form, connector);
      if (updateDisconnectsOAuthConnections(connector, body)) {
        openEditConfirmation({ connector, body });
        return;
      }
      saveUpdate(body);
      return;
    }
    detach(
      (async () => {
        await createConnector(buildCreateBody(form, oauth2Enabled), signal);
        close();
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <>
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
          <CustomConnectorForm
            form={form}
            setField={setField}
            oauth2Enabled={oauth2Enabled}
            editing={editing}
            advancedApiDefinition={advancedApiDefinition}
            addAuthMethod={addAuthMethod}
            removeAuthMethod={removeAuthMethod}
            submitting={submitting}
            canSubmit={canSubmit}
            onSubmit={onSubmit}
            onCancel={close}
          />
        </DialogContent>
      </Dialog>
      {connector && pendingUpdate?.connector.id === connector.id && (
        <CustomConnectorUpdateConfirm
          submitting={submitting}
          onCancel={closeEditConfirmation}
          onConfirm={() => {
            saveUpdate(pendingUpdate.body);
          }}
        />
      )}
    </>
  );
}
