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
        toast.success(`${label} copied`);
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
          Copy
        </Button>
      </div>
    </div>
  );
}

function formatTimestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "Not received";
}

function StrapiIntegrationHeader({
  integration,
}: {
  readonly integration: StrapiIntegration;
}) {
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
          Webhook tested
        </span>
      ) : null}
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
  const pageSignal = useGet(pageSignal$);
  const revealed = useGet(strapiRevealedSecret$);
  const [revealLoadable, reveal] = useLoadableSet(
    revealStrapiIntegrationSecret$,
  );
  const [checkLoadable, checkTest] = useLoadableSet(
    checkStrapiIntegrationTest$,
  );
  const [removeLoadable, remove] = useLoadableSet(removeStrapiIntegration$);
  const showingSecret = revealed?.integrationId === integration.id;
  const revealing = revealLoadable.state === "loading";
  const checking = checkLoadable.state === "loading";
  const removing = removeLoadable.state === "loading";

  return (
    <div className="zero-card overflow-hidden">
      <StrapiIntegrationHeader integration={integration} />

      <div className="space-y-4 border-t border-border/60 p-4">
        <CopyField label="Webhook URL" value={integration.webhookUrl} />
        {showingSecret && revealed ? (
          <CopyField
            label="Authorization header"
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
            Reveal authorization header
          </Button>
        ) : null}

        <div className="rounded-lg border border-border bg-muted/20 p-3 text-sm text-muted-foreground">
          In Strapi, open{" "}
          <strong className="text-foreground">Settings → Webhooks</strong>, add
          this URL and Authorization header, select <code>entry.publish</code>,
          then click <strong className="text-foreground">Trigger</strong> to
          send a Strapi test webhook.
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5 text-xs text-muted-foreground">
            <div>Last test: {formatTimestamp(integration.lastTestedAt)}</div>
            <div>
              Last publish: {formatTimestamp(integration.lastReceivedAt)}
            </div>
          </div>
          {isAdmin ? (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={checking}
                onClick={() => {
                  return detach(
                    checkTest(integration.id, pageSignal),
                    Reason.DomCallback,
                  );
                }}
              >
                {checking ? (
                  <IconLoader2 size={14} className="animate-spin" />
                ) : null}
                Check test
              </Button>
              <Dialog>
                <DialogTrigger asChild>
                  <Button type="button" variant="ghost" size="sm">
                    <IconTrash size={14} />
                    Remove
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Remove Strapi integration?</DialogTitle>
                    <DialogDescription>
                      Remove its workflow automations first. Strapi webhook
                      requests to this URL will stop working.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button type="button" variant="outline">
                        Cancel
                      </Button>
                    </DialogClose>
                    <DialogClose asChild>
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={removing}
                        onClick={() => {
                          return detach(
                            remove(integration.id, pageSignal),
                            Reason.DomCallback,
                          );
                        }}
                      >
                        Remove
                      </Button>
                    </DialogClose>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function StrapiIntegrationForm() {
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
          Add Strapi instance
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          One integration can serve multiple workflow automations.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="strapi-name" className="text-sm font-medium">
            Name
          </label>
          <Input
            id="strapi-name"
            value={form.name}
            required
            maxLength={128}
            placeholder="Company CMS"
            disabled={creating}
            onChange={(event) => {
              updateForm({ name: event.target.value });
            }}
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="strapi-url" className="text-sm font-medium">
            Strapi URL
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
        Create integration
      </Button>
    </form>
  );
}

export function ZeroStrapiSettingsPage() {
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
            Where Zero works
          </Link>
          <h1 className="text-lg font-semibold tracking-tight">Strapi</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Let Zero react to published Strapi entries and automate downstream
            work.
          </p>
        </div>
      </header>
      <main className="flex-1 overflow-auto px-4 pb-8 pt-3 sm:px-6">
        <div className="mx-auto flex max-w-[900px] flex-col gap-4">
          {isAdmin ? (
            <StrapiIntegrationForm />
          ) : (
            <div className="zero-card p-4 text-sm text-muted-foreground">
              Ask an organization admin to add or update Strapi integrations.
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
              No Strapi instances connected yet.
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
