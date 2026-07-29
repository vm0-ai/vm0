// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  IconSearch,
  IconShieldCheck,
  IconDots,
  IconPlus,
  IconClock,
  IconCheck,
  IconX,
  IconUserPlus,
} from "@tabler/icons-react";
import {
  cn,
  Input,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import {
  orgRoleSchema,
  type OrgRole,
} from "@vm0/api-contracts/contracts/org-members";
import {
  orgMembers$,
  orgPendingInvitations$,
  orgMembershipRequests$,
  type OrgMember,
  type OrgPendingInvitation,
  type OrgMembershipRequest,
} from "../../../../signals/external/org-members.ts";
import { isOrgAdmin$ } from "../../../../signals/org.ts";
import { user$ } from "../../../../signals/auth.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  memberSearch$,
  setMemberSearch$,
  inviteEmail$,
  setInviteEmail$,
  inviteTouched$,
  setInviteTouched$,
  inviteDialogOpen$,
  setInviteDialogOpen$,
  inviteRole$,
  setInviteRole$,
  selfDemoteDialogOpen$,
  setSelfDemoteDialogOpen$,
  removeMemberDialogTarget$,
  setRemoveMemberDialogTarget$,
  revokeInvitationDialogTarget$,
  setRevokeInvitationDialogTarget$,
  inviteMember$,
  changeRole$,
  selfDemote$,
  removeMember$,
  revokeInvitation$,
  acceptRequest$,
  rejectRequest$,
} from "../../../../signals/zero-page/settings/workspace-settings-state.ts";

const ROW_GRID = "grid grid-cols-[1fr_6rem_5.5rem_2rem] gap-x-4 items-center";

function displayName(m: OrgMember): string {
  const parts = [m.firstName, m.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "";
}

function formatDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale).format(new Date(iso));
}

export function OrgMembersTab() {
  const { t } = useTranslation();
  const membersLoadable = useLoadable(orgMembers$);
  const pendingLoadable = useLoadable(orgPendingInvitations$);
  const requestsLoadable = useLoadable(orgMembershipRequests$);
  const userLoadable = useLoadable(user$);
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;

  const search = useGet(memberSearch$);
  const setSearch = useSet(setMemberSearch$);

  const members =
    membersLoadable.state === "hasData" ? membersLoadable.data : [];
  const pendingInvitations =
    pendingLoadable.state === "hasData" ? pendingLoadable.data : [];
  const membershipRequests =
    requestsLoadable.state === "hasData" ? requestsLoadable.data : [];
  const currentUserId =
    userLoadable.state === "hasData" ? userLoadable.data?.id : undefined;
  const isLoading = membersLoadable.state === "loading";

  const adminCount = members.filter((m) => {
    return m.role === "admin";
  }).length;

  const filtered = (() => {
    if (!search.trim()) {
      return members;
    }
    const q = search.toLowerCase();
    return members.filter((m) => {
      return (
        m.email.toLowerCase().includes(q) ||
        displayName(m).toLowerCase().includes(q)
      );
    });
  })();

  const filteredPending = (() => {
    if (!search.trim()) {
      return pendingInvitations;
    }
    const q = search.toLowerCase();
    return pendingInvitations.filter((inv) => {
      return inv.email.toLowerCase().includes(q);
    });
  })();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <IconSearch
            size={15}
            stroke={1.5}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60"
          />
          <Input
            type="text"
            placeholder={t(($) => {
              return $.settings.workspace.members.search;
            })}
            value={search}
            onChange={(e) => {
              return setSearch(e.target.value);
            }}
            className="pl-9"
          />
        </div>
        {isAdmin && <InviteDialog />}
      </div>

      <div className="overflow-hidden rounded-xl bg-card zero-border">
        <div
          className={cn(
            ROW_GRID,
            "sticky top-0 z-10 px-5 py-2.5 text-[13px] font-medium text-foreground bg-card",
          )}
        >
          <div>
            {t(($) => {
              return $.settings.workspace.members.user;
            })}
          </div>
          <div>
            {t(($) => {
              return $.settings.workspace.members.joined;
            })}
          </div>
          <div>
            {t(($) => {
              return $.settings.workspace.members.role;
            })}
          </div>
          <div />
        </div>
        <div className="h-0 zero-border-t mx-5" />

        {isLoading && (
          <>
            <MemberRowSkeleton />
            <MemberRowSkeleton />
            <MemberRowSkeleton />
          </>
        )}

        {!isLoading &&
          filtered.length === 0 &&
          filteredPending.length === 0 &&
          membershipRequests.length === 0 && (
            <div className="flex items-center justify-center py-12">
              <span className="text-sm text-muted-foreground">
                {search.trim()
                  ? t(($) => {
                      return $.settings.workspace.members.emptySearch;
                    })
                  : t(($) => {
                      return $.settings.workspace.members.empty;
                    })}
              </span>
            </div>
          )}

        {!isLoading && membershipRequests.length > 0 && (
          <>
            <div className="px-5 pt-3 pb-1">
              <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                <IconUserPlus size={13} stroke={1.8} />
                {t(($) => {
                  return $.settings.workspace.members.joinRequests;
                })}
              </span>
            </div>
            {membershipRequests.map((req, i) => {
              return (
                <div key={req.id}>
                  {i > 0 && <div className="h-0 zero-border-t mx-5" />}
                  <MembershipRequestRow request={req} />
                </div>
              );
            })}
            <div className="h-0 zero-border-t mx-5" />
          </>
        )}

        {!isLoading &&
          filtered.map((m, i) => {
            return (
              <div key={m.userId}>
                {(i > 0 || membershipRequests.length > 0) && (
                  <div className="h-0 zero-border-t mx-5" />
                )}
                <MemberRow
                  member={m}
                  isCurrentUser={m.userId === currentUserId}
                  isAdmin={isAdmin}
                  isOnlyAdmin={adminCount < 2}
                />
              </div>
            );
          })}

        {!isLoading &&
          filteredPending.map((inv, i) => {
            return (
              <div key={inv.id}>
                {(i > 0 ||
                  filtered.length > 0 ||
                  membershipRequests.length > 0) && (
                  <div className="h-0 zero-border-t mx-5" />
                )}
                <PendingInvitationRow invitation={inv} isAdmin={isAdmin} />
              </div>
            );
          })}
      </div>
    </div>
  );
}

function InviteDialog() {
  const { t } = useTranslation();
  const email = useGet(inviteEmail$);
  const setEmail = useSet(setInviteEmail$);
  const open = useGet(inviteDialogOpen$);
  const setOpen = useSet(setInviteDialogOpen$);
  const role = useGet(inviteRole$);
  const setRole = useSet(setInviteRole$);
  const [loadable, doInvite] = useLoadableSet(inviteMember$);
  const sending = loadable.state === "loading";
  const pageSignal = useGet(pageSignal$);

  const trimmed = email.trim();
  const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);

  const touched = useGet(inviteTouched$);
  const setTouched = useSet(setInviteTouched$);

  const handleSend = () => {
    detach(doInvite(trimmed, role, pageSignal), Reason.DomCallback);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!sending) {
          setOpen(v);
          if (!v) {
            setRole(orgRoleSchema.parse("member"));
          }
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5 rounded-lg">
          <IconPlus size={14} stroke={2} />
          {t(($) => {
            return $.settings.workspace.members.addMember;
          })}
        </Button>
      </DialogTrigger>
      <DialogContent
        closeLabel={t(($) => {
          return $.settings.shared.close;
        })}
      >
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.settings.workspace.members.invite.title;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.settings.workspace.members.invite.description;
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Input
              placeholder={t(($) => {
                return $.settings.workspace.members.invite.emailPlaceholder;
              })}
              type="email"
              value={email}
              disabled={sending}
              onChange={(e) => {
                setEmail(e.target.value);
                setTouched(false);
              }}
              onBlur={() => {
                return setTouched(true);
              }}
            />
            {touched && trimmed && !isValid && (
              <p className="text-[13px] text-destructive">
                {t(($) => {
                  return $.settings.workspace.members.invite.invalidEmail;
                })}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">
              {t(($) => {
                return $.settings.workspace.members.invite.roleLabel;
              })}
            </label>
            <Select
              value={role}
              onValueChange={(v) => {
                return setRole(orgRoleSchema.parse(v));
              }}
              disabled={sending}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">
                  {t(($) => {
                    return $.settings.workspace.members.member;
                  })}
                </SelectItem>
                <SelectItem value="admin">
                  {t(($) => {
                    return $.settings.workspace.members.admin;
                  })}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              return setOpen(false);
            }}
            disabled={sending}
          >
            {t(($) => {
              return $.settings.shared.cancel;
            })}
          </Button>
          <Button size="sm" disabled={!isValid || sending} onClick={handleSend}>
            {sending
              ? t(($) => {
                  return $.settings.workspace.members.invite.progress;
                })
              : t(($) => {
                  return $.settings.workspace.members.invite.send;
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MemberRow({
  member,
  isCurrentUser,
  isAdmin,
  isOnlyAdmin,
}: {
  member: OrgMember;
  isCurrentUser: boolean;
  isAdmin: boolean;
  isOnlyAdmin: boolean;
}) {
  const { i18n, t } = useTranslation();
  const name = displayName(member);
  const initial = (name || member.email).charAt(0).toUpperCase();
  const canManage = isAdmin && !isCurrentUser;
  const canSelfDemote =
    isAdmin && isCurrentUser && member.role === "admin" && !isOnlyAdmin;

  return (
    <div className={cn(ROW_GRID, "py-3 px-5")}>
      <div className="flex items-center gap-3 min-w-0">
        <MemberAvatar
          imageUrl={member.imageUrl}
          initial={initial}
          name={name || member.email}
        />
        <div className="min-w-0">
          {name && (
            <span className="flex items-center gap-1.5 text-sm font-medium text-foreground truncate">
              {name}
              {isCurrentUser && (
                <span
                  data-testid="current-user-indicator"
                  className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium bg-muted text-muted-foreground leading-none"
                >
                  {t(($) => {
                    return $.settings.workspace.members.you;
                  })}
                </span>
              )}
            </span>
          )}
          <p className="text-[13px] text-muted-foreground truncate">
            {member.email}
          </p>
        </div>
      </div>
      <div className="text-[13px] text-muted-foreground tabular-nums">
        {formatDate(member.joinedAt, i18n.resolvedLanguage ?? i18n.language)}
      </div>
      <div>
        <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-muted-foreground zero-badge">
          <IconShieldCheck
            size={12}
            stroke={1.8}
            className={
              member.role === "admin"
                ? "text-blue-500"
                : "text-muted-foreground/40"
            }
          />
          {member.role === "admin"
            ? t(($) => {
                return $.settings.workspace.members.admin;
              })
            : t(($) => {
                return $.settings.workspace.members.member;
              })}
        </span>
      </div>
      <div className="flex justify-end">
        {canManage && <MemberActions member={member} />}
        {canSelfDemote && <SelfDemoteAction email={member.email} />}
      </div>
    </div>
  );
}

function SelfDemoteAction({ email }: { email: string }) {
  const { t } = useTranslation();
  const open = useGet(selfDemoteDialogOpen$);
  const setOpen = useSet(setSelfDemoteDialogOpen$);
  const [loadable, doSelfDemote] = useLoadableSet(selfDemote$);
  const loading = loadable.state === "loading";
  const pageSignal = useGet(pageSignal$);

  const handleConfirm = () => {
    detach(doSelfDemote(email, pageSignal), Reason.DomCallback);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!loading) {
          setOpen(v);
        }
      }}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label={t(
              ($) => {
                return $.settings.workspace.members.actionsFor;
              },
              {
                email,
              },
            )}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 transition-colors"
          >
            <IconDots size={15} stroke={1.5} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-48"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
          }}
        >
          <DialogTrigger asChild>
            <DropdownMenuItem>
              {t(($) => {
                return $.settings.workspace.members.selfDemote.action;
              })}
            </DropdownMenuItem>
          </DialogTrigger>
        </DropdownMenuContent>
      </DropdownMenu>

      <DialogContent
        closeLabel={t(($) => {
          return $.settings.shared.close;
        })}
      >
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.settings.workspace.members.selfDemote.title;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.settings.workspace.members.selfDemote.description;
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              return setOpen(false);
            }}
            disabled={loading}
          >
            {t(($) => {
              return $.settings.shared.cancel;
            })}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={loading}
            onClick={handleConfirm}
          >
            {loading
              ? t(($) => {
                  return $.settings.workspace.members.selfDemote.progress;
                })
              : t(($) => {
                  return $.settings.workspace.members.selfDemote.confirm;
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MemberActions({ member }: { member: OrgMember }) {
  const { t } = useTranslation();
  const newRole: OrgRole = member.role === "admin" ? "member" : "admin";
  const removeTarget = useGet(removeMemberDialogTarget$);
  const setRemoveTarget = useSet(setRemoveMemberDialogTarget$);
  const open = removeTarget === member.email;
  const [loadable, doRemove] = useLoadableSet(removeMember$);
  const [changeRoleLoadable, doChangeRole] = useLoadableSet(changeRole$);
  const changingRole = changeRoleLoadable.state === "loading";
  const removing = loadable.state === "loading";
  const pageSignal = useGet(pageSignal$);

  const handleRemove = () => {
    detach(doRemove(member.email, pageSignal), Reason.DomCallback);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!removing) {
          setRemoveTarget(v ? member.email : null);
        }
      }}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label={t(
              ($) => {
                return $.settings.workspace.members.actionsFor;
              },
              {
                email: member.email,
              },
            )}
            disabled={changingRole}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 transition-colors disabled:opacity-50 disabled:pointer-events-none"
          >
            <IconDots size={15} stroke={1.5} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-48"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
          }}
        >
          <DropdownMenuItem
            onClick={() => {
              return detach(
                doChangeRole(member.email, newRole, pageSignal),
                Reason.DomCallback,
              );
            }}
          >
            {newRole === "admin"
              ? t(($) => {
                  return $.settings.workspace.members.roleActions.makeAdmin;
                })
              : t(($) => {
                  return $.settings.workspace.members.roleActions.makeMember;
                })}
          </DropdownMenuItem>
          <DialogTrigger asChild>
            <DropdownMenuItem className="text-destructive focus:text-destructive">
              {t(($) => {
                return $.settings.workspace.members.remove.action;
              })}
            </DropdownMenuItem>
          </DialogTrigger>
        </DropdownMenuContent>
      </DropdownMenu>

      <DialogContent
        closeLabel={t(($) => {
          return $.settings.shared.close;
        })}
      >
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.settings.workspace.members.remove.title;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(
              ($) => {
                return $.settings.workspace.members.remove.confirmDescription;
              },
              {
                email: member.email,
              },
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              return setRemoveTarget(null);
            }}
            disabled={removing}
          >
            {t(($) => {
              return $.settings.shared.cancel;
            })}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={removing}
            onClick={handleRemove}
          >
            {removing
              ? t(($) => {
                  return $.settings.workspace.members.remove.progress;
                })
              : t(($) => {
                  return $.settings.shared.remove;
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PendingInvitationRow({
  invitation,
  isAdmin,
}: {
  invitation: OrgPendingInvitation;
  isAdmin: boolean;
}) {
  const { i18n, t } = useTranslation();
  const initial = invitation.email.charAt(0).toUpperCase();
  const revokeTarget = useGet(revokeInvitationDialogTarget$);
  const setRevokeTarget = useSet(setRevokeInvitationDialogTarget$);
  const open = revokeTarget === invitation.id;
  const [loadable, doRevoke] = useLoadableSet(revokeInvitation$);
  const revoking = loadable.state === "loading";
  const pageSignal = useGet(pageSignal$);

  const handleRevoke = () => {
    detach(doRevoke(invitation.id, pageSignal), Reason.DomCallback);
  };

  return (
    <div className={cn(ROW_GRID, "py-3 px-5")}>
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/50 text-xs font-medium text-muted-foreground border border-dashed border-border">
          {initial}
        </div>
        <div className="min-w-0">
          <p className="text-sm text-foreground truncate">{invitation.email}</p>
        </div>
      </div>
      <div className="text-[13px] text-muted-foreground tabular-nums">
        {formatDate(
          invitation.createdAt,
          i18n.resolvedLanguage ?? i18n.language,
        )}
      </div>
      <div>
        <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-muted-foreground zero-badge">
          <IconClock size={12} stroke={1.8} className="text-amber-500" />
          {t(($) => {
            return $.settings.workspace.members.pending;
          })}
        </span>
      </div>
      <div className="flex justify-end">
        {isAdmin && (
          <Dialog
            open={open}
            onOpenChange={(v) => {
              if (!revoking) {
                setRevokeTarget(v ? invitation.id : null);
              }
            }}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  aria-label={t(
                    ($) => {
                      return $.settings.workspace.members.actionsFor;
                    },
                    { email: invitation.email },
                  )}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 transition-colors"
                >
                  <IconDots size={15} stroke={1.5} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-48"
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                }}
              >
                <DialogTrigger asChild>
                  <DropdownMenuItem className="text-destructive focus:text-destructive">
                    {t(($) => {
                      return $.settings.workspace.members.revoke.action;
                    })}
                  </DropdownMenuItem>
                </DialogTrigger>
              </DropdownMenuContent>
            </DropdownMenu>

            <DialogContent
              closeLabel={t(($) => {
                return $.settings.shared.close;
              })}
            >
              <DialogHeader>
                <DialogTitle>
                  {t(($) => {
                    return $.settings.workspace.members.revoke.title;
                  })}
                </DialogTitle>
                <DialogDescription>
                  {t(
                    ($) => {
                      return $.settings.workspace.members.revoke
                        .confirmDescription;
                    },
                    { email: invitation.email },
                  )}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    return setRevokeTarget(null);
                  }}
                  disabled={revoking}
                >
                  {t(($) => {
                    return $.settings.shared.cancel;
                  })}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={revoking}
                  onClick={handleRevoke}
                >
                  {revoking
                    ? t(($) => {
                        return $.settings.workspace.members.revoke.progress;
                      })
                    : t(($) => {
                        return $.settings.workspace.members.revoke.button;
                      })}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>
    </div>
  );
}

function MembershipRequestRow({ request }: { request: OrgMembershipRequest }) {
  const { i18n, t } = useTranslation();
  const name = [request.firstName, request.lastName].filter(Boolean).join(" ");
  const initial = (name || request.email).charAt(0).toUpperCase();
  const [acceptLoadable, doAccept] = useLoadableSet(acceptRequest$);
  const [rejectLoadable, doReject] = useLoadableSet(rejectRequest$);
  const loading =
    acceptLoadable.state === "loading" || rejectLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);

  const handleAccept = () => {
    detach(doAccept(request.id, pageSignal), Reason.DomCallback);
  };

  const handleReject = () => {
    detach(doReject(request.id, pageSignal), Reason.DomCallback);
  };

  return (
    <div className={cn(ROW_GRID, "py-3 px-5")}>
      <div className="flex items-center gap-3 min-w-0">
        <MemberAvatar
          imageUrl={request.imageUrl}
          initial={initial}
          name={name || request.email}
        />
        <div className="min-w-0">
          {name && (
            <span className="text-sm font-medium text-foreground truncate block">
              {name}
            </span>
          )}
          <p className="text-[13px] text-muted-foreground truncate">
            {request.email}
          </p>
        </div>
      </div>
      <div className="text-[13px] text-muted-foreground tabular-nums">
        {formatDate(request.createdAt, i18n.resolvedLanguage ?? i18n.language)}
      </div>
      <div>
        <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-muted-foreground zero-badge">
          <IconUserPlus size={12} stroke={1.8} className="text-blue-500" />
          {t(($) => {
            return $.settings.workspace.members.membershipRequest.role;
          })}
        </span>
      </div>
      <div className="flex justify-end gap-1">
        <button
          className="flex h-7 w-7 items-center justify-center rounded-md text-green-600 hover:bg-green-50 dark:hover:bg-green-950/30 transition-colors disabled:opacity-50"
          onClick={handleAccept}
          disabled={loading}
          title={t(($) => {
            return $.settings.workspace.members.membershipRequest.acceptTitle;
          })}
        >
          <IconCheck size={15} stroke={2} />
        </button>
        <button
          className="flex h-7 w-7 items-center justify-center rounded-md text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
          onClick={handleReject}
          disabled={loading}
          title={t(($) => {
            return $.settings.workspace.members.membershipRequest.rejectTitle;
          })}
        >
          <IconX size={15} stroke={2} />
        </button>
      </div>
    </div>
  );
}

function MemberAvatar({
  imageUrl,
  initial,
  name,
}: {
  imageUrl: string;
  initial: string;
  name: string;
}) {
  if (imageUrl) {
    return (
      <div className="h-8 w-8 shrink-0 rounded-lg overflow-hidden">
        <img src={imageUrl} alt={name} className="h-full w-full object-cover" />
      </div>
    );
  }
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/50 text-xs font-medium text-muted-foreground">
      {initial}
    </div>
  );
}

function MemberRowSkeleton() {
  return (
    <div className={cn(ROW_GRID, "py-3 px-5 animate-pulse")}>
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 shrink-0 rounded-lg bg-muted/50" />
        <div className="flex flex-col gap-1">
          <div className="h-4 w-24 rounded bg-muted/50" />
          <div className="h-3 w-36 rounded bg-muted/30" />
        </div>
      </div>
      <div className="h-4 w-20 rounded bg-muted/30" />
      <div className="h-5 w-14 rounded bg-muted/30" />
      <div />
    </div>
  );
}
