import type { FormEvent } from "react";

import { IconPlus, IconTrash } from "@tabler/icons-react";
import type {
  CreateCustomConnectorBody,
  CustomConnectorAuthMethod,
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
  removeCustomConnectorAuthMethod$,
  resetCustomConnectorCreateForm$,
  setCustomConnectorCreateField$,
  type CustomConnectorCreateForm,
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
  onRemove,
}: CreateFormFieldProps & {
  readonly removable: boolean;
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
    </div>
  );
}

function customConnectorOAuthCallbackUrl(): string {
  return new URL(
    "/api/zero/custom-connectors/oauth2/callback",
    resolveApiBaseForTarget("api"),
  ).toString();
}

function OAuth2ClientFields({ form, setField }: CreateFormFieldProps) {
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
          Client secret
        </label>
        <Input
          id="cc-oauth-client-secret"
          type="password"
          value={form.oauthClientSecret}
          onChange={(event) => {
            setField("oauthClientSecret", event.target.value);
          }}
        />
      </div>
    </>
  );
}

function OAuth2AuthenticationFields({
  form,
  setField,
  onRemove,
}: CreateFormFieldProps & {
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
      <OAuth2ClientFields form={form} setField={setField} />
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
    </div>
  );
}

function LegacyApiFields(props: CreateFormFieldProps) {
  return <ApiAuthenticationFields {...props} removable={false} />;
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
  const supportsApi = form.authMethodTypes.includes("api");
  const supportsOAuth2 = form.authMethodTypes.includes("oauth2");
  const authMethods: CustomConnectorAuthMethod[] = form.authMethodTypes.map(
    (type) => {
      return type === "api"
        ? { type }
        : {
            type,
            authorizationUrl: form.oauthAuthorizationUrl.trim(),
            tokenUrl: form.oauthTokenUrl.trim(),
            scopes: parseScopes(form.oauthScopesRaw),
            clientAuthentication: form.oauthClientAuthentication,
          };
    },
  );
  return {
    displayName: form.displayName.trim(),
    prefixTemplates,
    fields: supportsApi
      ? [
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
      ? [
          {
            name: form.headerName.trim(),
            valueTemplate: form.headerTemplate.replaceAll(
              "{{secret}}",
              "{{secrets.secret}}",
            ),
          },
        ]
      : [],
    queryInjections: [],
    authMethods,
    ...(supportsOAuth2
      ? {
          oauthClientId: form.oauthClientId.trim(),
          oauthClientSecret: form.oauthClientSecret,
        }
      : {}),
  };
}

function formCanSubmit(
  form: CustomConnectorCreateForm,
  oauth2Enabled: boolean,
): boolean {
  if (
    form.displayName.trim().length === 0 ||
    parsePrefixLines(form.prefixesRaw).length === 0
  ) {
    return false;
  }
  if (!oauth2Enabled) {
    return (
      form.headerName.trim().length > 0 &&
      form.headerTemplate.includes("{{secret}}")
    );
  }
  if (form.authMethodTypes.length === 0) {
    return false;
  }
  if (
    form.authMethodTypes.includes("api") &&
    (form.headerName.trim().length === 0 ||
      !form.headerTemplate.includes("{{secret}}"))
  ) {
    return false;
  }
  return (
    !form.authMethodTypes.includes("oauth2") ||
    (form.oauthAuthorizationUrl.trim().length > 0 &&
      form.oauthTokenUrl.trim().length > 0 &&
      form.oauthClientId.trim().length > 0 &&
      form.oauthClientSecret.trim().length > 0)
  );
}

export function CustomConnectorCreateDialog() {
  const { t } = useTranslation();
  const form = useGet(customConnectorCreateForm$);
  const featureSwitches = useGet(featureSwitch$);
  const oauth2Enabled =
    featureSwitches[FeatureSwitchKey.CustomConnectorOAuth2] ?? false;
  const setField = useSet(setCustomConnectorCreateField$);
  const addAuthMethod = useSet(addCustomConnectorAuthMethod$);
  const removeAuthMethod = useSet(removeCustomConnectorAuthMethod$);
  const closeDialog = useSet(closeCustomConnectorDialog$);
  const resetForm = useSet(resetCustomConnectorCreateForm$);
  const [loadable, submit] = useLoadableSet(createCustomConnector$);
  const signal = useGet(pageSignal$);

  const submitting = loadable.state === "loading";
  const canSubmit = !submitting && formCanSubmit(form, oauth2Enabled);

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
        await submit(buildCreateBody(form, oauth2Enabled), signal);
        close();
      })(),
      Reason.DomCallback,
    );
  };

  const availableAuthMethods = (["api", "oauth2"] as const).filter((type) => {
    return !form.authMethodTypes.includes(type);
  });

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
            {t(($) => {
              return $.connectors.custom.create.title;
            })}
          </DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={onSubmit}>
          <BaseFields form={form} setField={setField} />
          {!oauth2Enabled && (
            <LegacyApiFields form={form} setField={setField} />
          )}
          {oauth2Enabled && (
            <>
              {form.authMethodTypes.includes("api") && (
                <ApiAuthenticationFields
                  form={form}
                  setField={setField}
                  removable
                  onRemove={() => {
                    removeAuthMethod("api");
                  }}
                />
              )}
              {form.authMethodTypes.includes("oauth2") && (
                <OAuth2AuthenticationFields
                  form={form}
                  setField={setField}
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
          )}
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
                    return $.connectors.actions.creating;
                  })
                : t(($) => {
                    return $.connectors.actions.create;
                  })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
