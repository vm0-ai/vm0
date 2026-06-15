"use client";

import { useEffect, useState } from "react";
import { useAuth, useOrganizationList } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";

import {
  completeDesktopAuth,
  completeDesktopAuthHandoff,
} from "../completeDesktopAuth";
import { DesktopAuthStatusPage } from "../DesktopAuthStatusPage";

const DESKTOP_AUTH_START_PATH = "/desktop-auth/start";

interface DesktopAuthSelectOrgClientProps {
  readonly forceSelection: boolean;
}

export function DesktopAuthSelectOrgClient({
  forceSelection,
}: DesktopAuthSelectOrgClientProps) {
  const { getToken, isLoaded: isAuthLoaded, isSignedIn, orgId } = useAuth();
  const searchParams = useSearchParams();
  const organizationList = useOrganizationList({
    userMemberships: { pageSize: 100 },
  });
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const handoffId = searchParams.get("handoffId");

  useEffect(() => {
    if (!isAuthLoaded) {
      return;
    }
    if (!isSignedIn) {
      window.location.replace(DESKTOP_AUTH_START_PATH);
      return;
    }
    if (!forceSelection && orgId) {
      completeDesktopAuth(getToken)
        .then((token) => {
          if (!handoffId) {
            return undefined;
          }
          return completeDesktopAuthHandoff(token, handoffId);
        })
        .then(() => {
          window.location.replace("/");
        })
        .catch((err: unknown) => {
          setError(
            err instanceof Error ? err.message : "Desktop sign-in failed.",
          );
        });
    }
  }, [forceSelection, getToken, handoffId, isAuthLoaded, isSignedIn, orgId]);

  function selectOrganization(organization: string): void {
    if (!organizationList.isLoaded) {
      return;
    }

    setSelectedOrgId(organization);
    void organizationList
      .setActive({ organization })
      .then(() => {
        return completeDesktopAuth(getToken);
      })
      .then((token) => {
        if (!handoffId) {
          return undefined;
        }
        return completeDesktopAuthHandoff(token, handoffId);
      })
      .then(() => {
        window.location.replace("/");
      })
      .catch((err: unknown) => {
        setSelectedOrgId(null);
        setError(
          err instanceof Error ? err.message : "Desktop sign-in failed.",
        );
      });
  }

  if (error) {
    return (
      <DesktopAuthStatusPage
        title="Desktop sign-in failed"
        description={error}
        tone="error"
      />
    );
  }

  if (!isAuthLoaded || !organizationList.isLoaded) {
    return (
      <DesktopAuthStatusPage
        title="Signing in to Zero"
        description="Loading the workspaces available for Zero Computer Use."
      />
    );
  }

  const memberships = organizationList.userMemberships.data ?? [];
  if (memberships.length === 0) {
    return (
      <DesktopAuthStatusPage
        title="No workspaces are available"
        description="Create or join a workspace before connecting this Mac to Zero Computer Use."
        tone="error"
      />
    );
  }

  return (
    <DesktopAuthStatusPage
      title="Select workspace"
      description="Choose the workspace that should receive this Mac as a Computer Use runtime."
      tone="waiting"
    >
      <div className="grid gap-3">
        {memberships.map((membership) => {
          const organization = membership.organization;
          return (
            <button
              key={organization.id}
              type="button"
              onClick={() => {
                selectOrganization(organization.id);
              }}
              disabled={selectedOrgId !== null}
              aria-busy={selectedOrgId === organization.id}
              className="flex min-h-[3.25rem] items-center justify-between rounded-lg border border-border bg-background px-4 py-3 text-left text-sm text-foreground transition-colors hover:bg-muted disabled:cursor-wait disabled:opacity-80"
            >
              <span className="truncate">{organization.name}</span>
              {selectedOrgId === organization.id ? (
                <span className="ml-3 shrink-0 text-muted-foreground">
                  Signing in...
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </DesktopAuthStatusPage>
  );
}
