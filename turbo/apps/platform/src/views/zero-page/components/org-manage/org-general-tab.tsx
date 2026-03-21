/* eslint-disable ccstate/no-use-ccstate-in-views */
import { useLoadable, useGet, useSet } from "ccstate-react";
import { useCCState } from "ccstate-react/experimental";
import { IconUpload } from "@tabler/icons-react";
import {
  Input,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@vm0/ui";
import { org$, type Org } from "../../../../signals/org.ts";

const sectionCardStyle = {
  border: "0.7px solid hsl(var(--gray-400))",
} as const;

const inputStyle = { border: "0.7px solid hsl(var(--gray-400))" } as const;

export function OrgGeneralTab() {
  const orgLoadable = useLoadable(org$);
  const org = orgLoadable.state === "hasData" ? orgLoadable.data : undefined;
  const isLoading = orgLoadable.state === "loading";

  if (isLoading) {
    return (
      <div className="flex flex-col gap-8">
        <FieldSkeleton />
        <FieldSkeleton />
      </div>
    );
  }

  if (!org) {
    return null;
  }

  return <OrgGeneralContent key={org.slug} org={org} />;
}

function OrgGeneralContent({ org }: { org: Org }) {
  const name$ = useCCState(org.slug);
  const name = useGet(name$);
  const setName = useSet(name$);
  const hasChanges = name !== org.slug;

  return (
    <div className="flex flex-col gap-8">
      {/* Profile section */}
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-foreground">Profile</h3>
        <div
          className="overflow-hidden rounded-xl bg-card"
          style={sectionCardStyle}
        >
          {/* Logo row */}
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Logo</p>
              <p className="text-[13px] text-muted-foreground mt-0.5">
                Organization avatar displayed across the app
              </p>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted/50 text-sm font-semibold text-muted-foreground">
                {org.slug.charAt(0).toUpperCase()}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 rounded-lg"
                style={inputStyle}
              >
                <IconUpload size={13} stroke={1.5} />
                Upload
              </Button>
            </div>
          </div>
          <div className="h-px bg-border/40 mx-5" />
          {/* Name row */}
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <label
                htmlFor="org-name"
                className="text-sm font-medium text-foreground"
              >
                Name
              </label>
              <p className="text-[13px] text-muted-foreground mt-0.5">
                Used to identify this organization
              </p>
            </div>
            <Input
              id="org-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Organization name"
              className="h-9 w-[220px] shrink-0 rounded-lg border-[0.7px] border-[hsl(var(--gray-400))]"
            />
          </div>
        </div>

        {hasChanges && (
          <div className="flex items-center gap-2">
            <Button size="sm" className="rounded-lg">
              Save changes
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-lg text-muted-foreground"
              onClick={() => setName(org.slug)}
            >
              Discard
            </Button>
          </div>
        )}
      </section>

      {/* Danger zone */}
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-foreground">Danger zone</h3>
        <div
          className="overflow-hidden rounded-xl bg-card"
          style={sectionCardStyle}
        >
          {/* Leave organization */}
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                Leave organization
              </p>
              <p className="text-[13px] text-muted-foreground mt-0.5">
                You will lose access to this organization and its resources.
              </p>
            </div>
            <Dialog>
              <DialogTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 gap-1.5 rounded-lg"
                  style={inputStyle}
                >
                  Leave
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Leave organization?</DialogTitle>
                  <DialogDescription>
                    You will no longer have access to this organization. You can
                    rejoin only if an admin invites you again.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="outline" size="sm">
                      Cancel
                    </Button>
                  </DialogClose>
                  <Button variant="destructive" size="sm">
                    Leave
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
          <div className="h-px bg-border/40 mx-5" />
          {/* Delete organization */}
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                Delete organization
              </p>
              <p className="text-[13px] text-muted-foreground mt-0.5">
                Permanently delete this organization and all its data. This
                action cannot be undone.
              </p>
            </div>
            <Dialog>
              <DialogTrigger asChild>
                <Button
                  variant="destructive"
                  size="sm"
                  className="shrink-0 gap-1.5"
                >
                  Delete
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Delete organization?</DialogTitle>
                  <DialogDescription>
                    This will permanently delete the organization, all agents,
                    data, and member access. This action cannot be undone.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="outline" size="sm">
                      Cancel
                    </Button>
                  </DialogClose>
                  <Button variant="destructive" size="sm">
                    Delete organization
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </section>
    </div>
  );
}

function FieldSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <div className="h-4 w-16 rounded bg-muted/50 animate-pulse" />
      <div className="h-9 w-full rounded-lg bg-muted/30 animate-pulse" />
    </div>
  );
}
