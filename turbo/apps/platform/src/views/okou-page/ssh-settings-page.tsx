import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
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
  SSH_CONNECTION_LIMIT,
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
  refreshSsh$,
  saveSsh$,
} from "../../signals/ssh.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

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
          maxLength={SSH_USERNAME_MAX_LENGTH}
          defaultValue={connection?.username}
        />
      </label>
    </>
  );
}

function CredentialFields() {
  const { t } = useTranslation();
  return (
    <>
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.ssh.credentialsHelp;
        })}
      </p>
      <label className="grid gap-2">
        {t(($) => {
          return $.ssh.privateKey;
        })}
        <Textarea
          name="privateKey"
          required
          maxLength={SSH_PRIVATE_KEY_MAX_LENGTH}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
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
          : t(($) => {
              return $.ssh.tofu;
            });
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
        className="max-h-[90vh] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const values = new FormData(form);
            // Never retain credentials in ccstate, query caches or the DOM during I/O.
            form.reset();
            detach(save(values, signal), Reason.DomCallback);
          }}
        >
          {(dialog.kind === "create" || dialog.kind === "edit") && (
            <EndpointFields connection={dialog.connection} />
          )}
          {(dialog.kind === "create" || dialog.kind === "rotate") && (
            <CredentialFields />
          )}
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
              disabled={saving.state === "loading"}
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

export function SshSettingsPage() {
  const { t } = useTranslation();
  const hosts = useLoadable(sshConnections$);
  const conflict = useGet(sshConflict$);
  const open = useSet(openSshDialog$);
  const refresh = useSet(refreshSsh$);
  const signal = useGet(pageSignal$);
  if (hosts.state === "loading") {
    return (
      <p className="p-6">
        {t(($) => {
          return $.ssh.loading;
        })}
      </p>
    );
  }
  if (hosts.state !== "hasData" || !hosts.data) {
    return (
      <p className="p-6">
        {t(($) => {
          return $.ssh.unavailable;
        })}
      </p>
    );
  }
  return (
    <main className="mx-auto grid w-full max-w-3xl gap-5 p-6">
      <h1 className="text-xl font-semibold">
        {t(($) => {
          return $.ssh.title;
        })}
      </h1>
      <p className="text-sm text-muted-foreground">
        {t(
          ($) => {
            return $.ssh.count;
          },
          {
            count: hosts.data.length,
            limit: SSH_CONNECTION_LIMIT,
          },
        )}
      </p>
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.ssh.cache;
        })}
      </p>
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.ssh.tofu;
        })}
      </p>
      {conflict && (
        <p role="alert" className="text-sm">
          {t(($) => {
            return $.ssh.conflict;
          })}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          disabled={hosts.data.length >= SSH_CONNECTION_LIMIT}
          onClick={() => {
            return detach(open("create", null, signal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.ssh.add;
          })}
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            return refresh();
          }}
        >
          {t(($) => {
            return $.ssh.refresh;
          })}
        </Button>
      </div>
      {hosts.data.length === 0 && (
        <p>
          {t(($) => {
            return $.ssh.empty;
          })}
        </p>
      )}
      {hosts.data.map((connection) => {
        return <HostCard key={connection.id} connection={connection} />;
      })}
      <SshDialog />
    </main>
  );
}
