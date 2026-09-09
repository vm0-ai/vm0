import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Plug, Plus, Terminal } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Input,
  Textarea,
} from "@okouai/ui";
import {
  SSH_DISPLAY_NAME_MAX_LENGTH,
  SSH_HOST_MAX_LENGTH,
  SSH_USERNAME_MAX_LENGTH,
  SSH_PRIVATE_KEY_MAX_LENGTH,
  SSH_PASSPHRASE_MAX_LENGTH,
  type SshConnectionResponse,
} from "@okouai/api-contracts/contracts/ssh-connections";
import {
  sshConnections$,
  sshConflict$,
  sshDialog$,
  openSshDialog$,
  closeSshDialog$,
  saveSsh$,
  cancelSshPrivateKeyFile$,
  importSshPrivateKeyFile$,
  mountSshPrivateKey$,
  sshPrivateKeyFileResult$,
} from "../../signals/ssh.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { Link } from "../router/link.tsx";
import { SshLoadError } from "./ssh-load-error.tsx";
import { localizedSshError } from "../../lib/ssh-error.ts";
import {
  DetailPageBreadcrumbBar,
  DetailPageHeader,
  DetailPageMain,
  DetailPageShell,
} from "../components/detail-page-layout.tsx";

function EndpointFields({
  connection,
}: {
  readonly connection: SshConnectionResponse | null;
}) {
  const { t } = useTranslation();
  return (
    <>
      <label className="grid gap-2">
        {t(($) => {
          return $.ssh.displayName;
        })}
        <Input
          name="displayName"
          required
          pattern=".*\S.*"
          maxLength={SSH_DISPLAY_NAME_MAX_LENGTH}
          defaultValue={connection?.displayName}
        />
      </label>
      <label className="grid gap-2">
        {t(($) => {
          return $.ssh.host;
        })}
        <Input
          name="host"
          required
          pattern=".*\S.*"
          maxLength={SSH_HOST_MAX_LENGTH}
          defaultValue={connection?.host}
        />
      </label>
      <label className="grid gap-2">
        {t(($) => {
          return $.ssh.port;
        })}
        <Input
          name="port"
          type="number"
          className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          required
          min={1}
          max={65_535}
          defaultValue={connection?.port ?? 22}
        />
      </label>
      <label className="grid gap-2">
        {t(($) => {
          return $.ssh.username;
        })}
        <Input
          name="username"
          required
          pattern=".*\S.*"
          maxLength={SSH_USERNAME_MAX_LENGTH}
          defaultValue={connection?.username}
        />
      </label>
    </>
  );
}

function CredentialFields() {
  const { t } = useTranslation();
  const importFile = useSet(importSshPrivateKeyFile$);
  const cancelRead = useSet(cancelSshPrivateKeyFile$);
  const mountPrivateKey = useSet(mountSshPrivateKey$);
  const result = useLoadable(sshPrivateKeyFileResult$);
  const signal = useGet(pageSignal$);
  return (
    <>
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.ssh.credentialsHelp;
        })}
      </p>
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="ssh-private-key">
            {t(($) => {
              return $.ssh.privateKey;
            })}
          </label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={(event) => {
              const input = event.currentTarget
                .closest("form")
                ?.elements.namedItem("ssh-private-key-file");
              if (!(input instanceof HTMLInputElement)) {
                throw new Error(
                  "SSH credential form is missing its file input",
                );
              }
              input.click();
            }}
          >
            {t(($) => {
              return $.ssh.chooseFile;
            })}
          </Button>
        </div>
        <input
          id="ssh-private-key-file"
          type="file"
          className="hidden"
          aria-label={t(($) => {
            return $.ssh.choosePrivateKeyFile;
          })}
          onChange={(event) => {
            detach(importFile(event.currentTarget, signal), Reason.DomCallback);
          }}
        />
        <Textarea
          id="ssh-private-key"
          ref={mountPrivateKey}
          name="privateKey"
          required
          maxLength={SSH_PRIVATE_KEY_MAX_LENGTH}
          autoComplete="off"
          spellCheck={false}
          onInput={() => {
            cancelRead();
          }}
        />
        {result.state === "loading" && (
          <p role="status" className="text-sm text-muted-foreground">
            {t(($) => {
              return $.ssh.fileReading;
            })}
          </p>
        )}
        {result.state === "hasData" && result.data !== null && (
          <p role="alert" className="text-sm text-destructive">
            {result.data === "size"
              ? t(($) => {
                  return $.ssh.fileSizeError;
                })
              : t(($) => {
                  return $.ssh.fileReadError;
                })}
          </p>
        )}
      </div>
      <label className="grid gap-2">
        {t(($) => {
          return $.ssh.passphrase;
        })}
        <Input
          name="passphrase"
          type="password"
          maxLength={SSH_PASSPHRASE_MAX_LENGTH}
          autoComplete="new-password"
        />
      </label>
    </>
  );
}

function SshDialog() {
  const { t } = useTranslation();
  const data = useLoadable(sshDialog$);
  const close = useSet(closeSshDialog$);
  const [saving, save] = useLoadableSet(saveSsh$);
  const signal = useGet(pageSignal$);
  const cancelRead = useSet(cancelSshPrivateKeyFile$);
  const fileResult = useLoadable(sshPrivateKeyFileResult$);
  const dialog = data.state === "hasData" ? data.data : null;
  if (!dialog) {
    return null;
  }
  const title =
    dialog.kind === "create"
      ? t(($) => {
          return $.ssh.add;
        })
      : dialog.kind === "edit"
        ? t(($) => {
            return $.ssh.edit;
          })
        : dialog.kind === "rotate"
          ? t(($) => {
              return $.ssh.rotate;
            })
          : dialog.kind === "reset"
            ? t(($) => {
                return $.ssh.reset;
              })
            : t(($) => {
                return $.ssh.delete;
              });
  const description =
    dialog.kind === "reset"
      ? t(($) => {
          return $.ssh.resetHelp;
        })
      : dialog.kind === "delete"
        ? t(($) => {
            return $.ssh.deleteHelp;
          })
        : dialog.kind === "edit"
          ? t(($) => {
              return $.ssh.editHelp;
            })
          : null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && saving.state !== "loading") {
          close();
        }
      }}
    >
      <DialogContent
        key={`${dialog.identity}:${dialog.kind}:${dialog.connection?.id ?? "new"}`}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form
          className="grid gap-4"
          autoComplete="off"
          onReset={() => {
            cancelRead();
          }}
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const values = new FormData(form);
            // Never retain credentials in ccstate, query caches or the DOM during I/O.
            form.reset();
            detach(save(values, signal), Reason.DomCallback);
          }}
        >
          {["create", "edit"].includes(dialog.kind) && (
            <EndpointFields connection={dialog.connection} />
          )}
          {["create", "rotate"].includes(dialog.kind) && <CredentialFields />}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={saving.state === "loading"}
              onClick={() => {
                return close();
              }}
            >
              {t(($) => {
                return $.ssh.cancel;
              })}
            </Button>
            <Button
              type="submit"
              disabled={[saving.state, fileResult.state].includes("loading")}
              variant={
                dialog.kind === "delete" || dialog.kind === "reset"
                  ? "destructive"
                  : "default"
              }
            >
              {dialog.kind === "delete" || dialog.kind === "reset"
                ? title
                : t(($) => {
                    return $.ssh.save;
                  })}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function HostCard({
  connection,
}: {
  readonly connection: SshConnectionResponse;
}) {
  const { t } = useTranslation();
  const open = useSet(openSshDialog$);
  const signal = useGet(pageSignal$);
  return (
    <article className="grid gap-3 rounded-xl border bg-card p-5">
      <h2 className="font-semibold">{connection.displayName}</h2>
      <p className="break-all text-sm">
        {connection.username}@{connection.host}:{connection.port}
      </p>
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.ssh.configured;
        })}
      </p>
      <p className="break-all text-sm">
        {t(($) => {
          return $.ssh.id;
        })}
        : <code>{connection.id}</code>
      </p>
      <p className="break-all text-sm">
        {connection.learnedHostKey ? (
          <>
            {t(($) => {
              return $.ssh.fingerprint;
            })}
            : {connection.learnedHostKey.algorithm}{" "}
            <code>{connection.learnedHostKey.fingerprint}</code>
          </>
        ) : (
          t(($) => {
            return $.ssh.notLearned;
          })
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => {
            return detach(open("edit", connection, signal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.ssh.edit;
          })}
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            return detach(
              open("rotate", connection, signal),
              Reason.DomCallback,
            );
          }}
        >
          {t(($) => {
            return $.ssh.rotate;
          })}
        </Button>
        <Button
          variant="outline"
          disabled={!connection.learnedHostKey}
          onClick={() => {
            return detach(
              open("reset", connection, signal),
              Reason.DomCallback,
            );
          }}
        >
          {t(($) => {
            return $.ssh.reset;
          })}
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            return detach(
              open("delete", connection, signal),
              Reason.DomCallback,
            );
          }}
        >
          {t(($) => {
            return $.ssh.delete;
          })}
        </Button>
      </div>
    </article>
  );
}

function SshHosts() {
  const { t } = useTranslation();
  const hosts = useLoadable(sshConnections$);
  const conflict = useGet(sshConflict$);
  const open = useSet(openSshDialog$);
  const signal = useGet(pageSignal$);
  if (hosts.state === "loading") {
    return (
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.ssh.loading;
        })}
      </p>
    );
  }
  if (hosts.state === "hasError") {
    return <SshLoadError />;
  }
  if (!hosts.data) {
    return (
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.ssh.unavailable;
        })}
      </p>
    );
  }
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {t(
            ($) => {
              return $.ssh.summary;
            },
            {
              count: hosts.data.length,
            },
          )}
        </p>
        <Button
          onClick={() => {
            return detach(open("create", null, signal), Reason.DomCallback);
          }}
        >
          <Plus size={16} aria-hidden="true" />
          {t(($) => {
            return $.ssh.add;
          })}
        </Button>
      </div>
      {conflict && (
        <p role="alert" className="text-sm">
          {localizedSshError(conflict) ??
            t(($) => {
              return $.ssh.errors.failed;
            })}
        </p>
      )}
      {hosts.data.length === 0 && (
        <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t(($) => {
            return $.ssh.empty;
          })}
        </p>
      )}
      {hosts.data.map((connection) => {
        return <HostCard key={connection.id} connection={connection} />;
      })}
    </div>
  );
}

export function SshConnectorPage() {
  const { t } = useTranslation();
  return (
    <DetailPageShell>
      <DetailPageBreadcrumbBar>
        <Link
          pathname={ROUTES.connectors}
          className="inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-inherit no-underline transition-colors hover:bg-state-hover hover:text-foreground"
        >
          <Plug size={14} className="shrink-0" aria-hidden="true" />
          {t(($) => {
            return $.appShell.sidebar.navigation.connectors;
          })}
        </Link>
        <span className="select-none text-muted-foreground/40">/</span>
        <span
          aria-current="page"
          className="min-w-0 truncate rounded-md px-1.5 py-0.5 font-medium text-foreground"
        >
          {t(($) => {
            return $.ssh.label;
          })}
        </span>
      </DetailPageBreadcrumbBar>
      <DetailPageHeader>
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gray-100 text-muted-foreground sm:h-16 sm:w-16">
            <Terminal size={28} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
              {t(($) => {
                return $.ssh.title;
              })}
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {t(($) => {
                return $.ssh.description;
              })}
            </p>
          </div>
        </div>
      </DetailPageHeader>
      <DetailPageMain constrainContent>
        <SshHosts />
        <SshDialog />
      </DetailPageMain>
    </DetailPageShell>
  );
}
