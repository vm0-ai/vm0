import type { FormEvent } from "react";

import type { StrapiIntegration } from "@vm0/api-contracts/contracts/zero-strapi-integrations";
import {
  IconArrowLeft,
  IconCircleCheck,
  IconCopy,
  IconLoader2,
  IconPlus,
  IconTrash,
  IconWebhook,
} from "@tabler/icons-react";
import { Button } from "@vm0/ui";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@vm0/ui/components/ui/dialog";
import { Input } from "@vm0/ui/components/ui/input";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import { toast } from "@vm0/ui/components/ui/sonner";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";

import { resolvedAppLocale } from "../../i18n/format.ts";
import { i18n } from "../../i18n/index.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { writeToClipboard } from "../../signals/zero-page/clipboard.ts";
import {
  checkStrapiIntegrationTest$,
  createStrapiIntegration$,
  removeStrapiIntegration$,
  revealStrapiIntegrationSecret$,
  strapiIntegrationForm$,
  strapiIntegrations$,
  strapiRevealedSecret$,
  updateStrapiIntegrationForm$,
} from "../../signals/zero-page/zero-strapi.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";

function copyValue(value: string, label: string): void {
  detach(
    (async () => {
      if (await writeToClipboard(value)) {
        toast.success(
          i18n.t(
            ($) => {
              return $.connectors.providerSettings.strapi.copied;
            },
            { label },
          ),
        );
      }
    })(),
    Reason.DomCallback,
  );
}

function CopyField({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
          {value}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            copyValue(value, label);
          }}
        >
          <IconCopy size={14} />
          {t(($) => {
            return $.connectors.providerSettings.strapi.actions.copy;
          })}
        </Button>
      </div>
    </div>
  );
}

function formatTimestamp(value: string | null): string {
  return value
    ? new Date(value).toLocaleString(resolvedAppLocale())
    : i18n.t(($) => {
        return $.connectors.providerSettings.strapi.notReceived;
      });
}

function StrapiIntegrationHeader({
  integration,
}: {
  readonly integration: StrapiIntegration;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-4 p-4">
      <div className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#4945ff]/10 text-[#4945ff]">
        <IconWebhook size={20} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-foreground">{integration.name}</div>
        <div className="truncate text-sm text-muted-foreground">
          {integration.baseUrl}
        </div>
      </div>
      {integration.lastTestedAt ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs font-medium">
          <IconCircleCheck size={14} className="text-green-600" />
          {t(($) => {
            return $.connectors.providerSettings.strapi.tested;
          })}
        </span>
      ) : null}
    </div>
  );
}

function StrapiAdminActions({
  integrationId,
}: {
  readonly integrationId: string;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const [checkLoadable, checkTest] = useLoadableSet(
    checkStrapiIntegrationTest$,
  );
  const [removeLoadable, remove] = useLoadableSet(removeStrapiIntegration$);
  const checking = checkLoadable.state === "loading";
  const removing = removeLoadable.state === "loading";

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={checking}
        onClick={() => {
          return detach(
            checkTest(integrationId, pageSignal),
            Reason.DomCallback,
          );
        }}
      >
        {checking ? <IconLoader2 size={14} className="animate-spin" /> : null}
        {t(($) => {
          return $.connectors.providerSettings.strapi.actions.checkTest;
        })}
      </Button>
      <Dialog>
        <DialogTrigger asChild>
          <Button type="button" variant="ghost" size="sm">
            <IconTrash size={14} />
            {t(($) => {
              return $.connectors.providerSettings.strapi.actions.remove;
            })}
          </Button>
        </DialogTrigger>
        <DialogContent
          closeLabel={t(($) => {
            return $.connectors.actions.close;
          })}
        >
          <DialogHeader>
            <DialogTitle>
              {t(($) => {
                return $.connectors.providerSettings.strapi.removeTitle;
              })}
            </DialogTitle>
            <DialogDescription>
              {t(($) => {
                return $.connectors.providerSettings.strapi.removeDescription;
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t(($) => {
                  return $.connectors.providerSettings.strapi.actions.cancel;
                })}
              </Button>
            </DialogClose>
            <DialogClose asChild>
              <Button
                type="button"
                variant="destructive"
                disabled={removing}
                onClick={() => {
                  return detach(
                    remove(integrationId, pageSignal),
                    Reason.DomCallback,
                  );
                }}
              >
                {t(($) => {
                  return $.connectors.providerSettings.strapi.actions.remove;
                })}
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StrapiIntegrationCard({
  integration,
  isAdmin,
}: {
  readonly integration: StrapiIntegration;
  readonly isAdmin: boolean;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const revealed = useGet(strapiRevealedSecret$);
  const [revealLoadable, reveal] = useLoadableSet(
    revealStrapiIntegrationSecret$,
  );
  const showingSecret = revealed?.integrationId === integration.id;
  const revealing = revealLoadable.state === "loading";

  return (
    <div className="zero-card overflow-hidden">
      <StrapiIntegrationHeader integration={integration} />

      <div className="space-y-4 border-t border-border/60 p-4">
        <CopyField
          label={t(($) => {
            return $.connectors.providerSettings.strapi.webhookUrl;
          })}
          value={integration.webhookUrl}
        />
        {showingSecret && revealed ? (
          <CopyField
            label={t(($) => {
              return $.connectors.providerSettings.strapi.authorizationHeader;
            })}
            value={revealed.authorizationHeader}
          />
        ) : isAdmin ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={revealing}
            onClick={() => {
              return detach(
                reveal(integration.id, pageSignal),
                Reason.DomCallback,
              );
            }}
          >
            {revealing ? (
              <IconLoader2 size={14} className="animate-spin" />
            ) : null}
            {t(($) => {
              return $.connectors.providerSettings.strapi.actions
                .revealAuthorization;
            })}
          </Button>
        ) : null}

        <div className="rounded-lg border border-border bg-muted/20 p-3 text-sm text-muted-foreground">
          {t(($) => {
            return $.connectors.providerSettings.strapi.instructions;
          })}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5 text-xs text-muted-foreground">
            <div>
              {t(
                ($) => {
                  return $.connectors.providerSettings.strapi.lastTest;
                },
                { date: formatTimestamp(integration.lastTestedAt) },
              )}
            </div>
            <div>
              {t(
                ($) => {
                  return $.connectors.providerSettings.strapi.lastPublish;
                },
                { date: formatTimestamp(integration.lastReceivedAt) },
              )}
            </div>
          </div>
          {isAdmin ? (
            <StrapiAdminActions integrationId={integration.id} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function StrapiIntegrationForm() {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const form = useGet(strapiIntegrationForm$);
  const updateForm = useSet(updateStrapiIntegrationForm$);
  const [createLoadable, create] = useLoadableSet(createStrapiIntegration$);
  const creating = createLoadable.state === "loading";
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    detach(create(pageSignal), Reason.DomCallback);
  };
  return (
    <form className="zero-card space-y-4 p-4" onSubmit={submit}>
      <div>
        <h2 className="text-sm font-medium text-foreground">
          {t(($) => {
            return $.connectors.providerSettings.strapi.addTitle;
          })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(($) => {
            return $.connectors.providerSettings.strapi.addDescription;
          })}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="strapi-name" className="text-sm font-medium">
            {t(($) => {
              return $.connectors.providerSettings.strapi.form.name;
            })}
          </label>
          <Input
            id="strapi-name"
            value={form.name}
            required
            maxLength={128}
            placeholder={t(($) => {
              return $.connectors.providerSettings.strapi.form.namePlaceholder;
            })}
            disabled={creating}
            onChange={(event) => {
              updateForm({ name: event.target.value });
            }}
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="strapi-url" className="text-sm font-medium">
            {t(($) => {
              return $.connectors.providerSettings.strapi.form.url;
            })}
          </label>
          <Input
            id="strapi-url"
            type="url"
            value={form.baseUrl}
            required
            placeholder="https://cms.example.com"
            disabled={creating}
            onChange={(event) => {
              updateForm({ baseUrl: event.target.value });
            }}
          />
        </div>
      </div>
      <Button type="submit" disabled={creating}>
        {creating ? (
          <IconLoader2 size={16} className="animate-spin" />
        ) : (
          <IconPlus size={16} />
        )}
        {t(($) => {
          return $.connectors.providerSettings.strapi.actions.create;
        })}
      </Button>
    </form>
  );
}

export function ZeroStrapiSettingsPage() {
  const { t } = useTranslation();
  const integrationsLoadable = useLastLoadable(strapiIntegrations$);
  const adminLoadable = useLastLoadable(isOrgAdmin$);
  const isAdmin =
    adminLoadable.state === "hasData" && adminLoadable.data === true;
  const integrations =
    integrationsLoadable.state === "hasData" ? integrationsLoadable.data : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 px-4 pb-3 pt-8 sm:px-6">
        <div className="mx-auto max-w-[900px]">
          <Link
            pathname={ROUTES.works}
            className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <IconArrowLeft size={16} />
            {t(($) => {
              return $.connectors.providerSettings.strapi.whereZeroWorks;
            })}
          </Link>
          <h1 className="text-lg font-semibold tracking-tight">
            {t(($) => {
              return $.connectors.providerSettings.strapi.title;
            })}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(($) => {
              return $.connectors.providerSettings.strapi.description;
            })}
          </p>
        </div>
      </header>
      <main className="flex-1 overflow-auto px-4 pb-8 pt-3 sm:px-6">
        <div className="mx-auto flex max-w-[900px] flex-col gap-4">
          {isAdmin ? (
            <StrapiIntegrationForm />
          ) : (
            <div className="zero-card p-4 text-sm text-muted-foreground">
              {t(($) => {
                return $.connectors.providerSettings.strapi.adminRequired;
              })}
            </div>
          )}
          {integrations === null ? (
            <div className="zero-card space-y-3 p-4">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-2/3" />
            </div>
          ) : integrations.length === 0 ? (
            <div className="zero-card p-6 text-center text-sm text-muted-foreground">
              {t(($) => {
                return $.connectors.providerSettings.strapi.empty;
              })}
            </div>
          ) : (
            integrations.map((integration) => {
              return (
                <StrapiIntegrationCard
                  key={integration.id}
                  integration={integration}
                  isAdmin={isAdmin}
                />
              );
            })
          )}
        </div>
      </main>
    </div>
  );
}
