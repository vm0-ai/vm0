"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth, useOrganizationList } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";

import {
  completeDesktopAuth,
  completeDesktopAuthHandoff,
} from "../completeDesktopAuth";

const DESKTOP_AUTH_START_PATH = "/desktop-auth/start";
const DESKTOP_AUTH_SELECT_ORG_PATH = "/desktop-auth/select-org";

function desktopAuthSelectOrgPath(handoffId: string | null): string {
  if (!handoffId) {
    return DESKTOP_AUTH_SELECT_ORG_PATH;
  }

  const params = new URLSearchParams({ handoffId });
  return `${DESKTOP_AUTH_SELECT_ORG_PATH}?${params.toString()}`;
}

export function DesktopAuthTokenClient() {
  const { getToken, isLoaded: isAuthLoaded, isSignedIn, orgId } = useAuth();
  const searchParams = useSearchParams();
  const organizationList = useOrganizationList({
    userMemberships: { pageSize: 100 },
  });
  const [error, setError] = useState("");
  const didRun = useRef(false);
  const handoffId = searchParams.get("handoffId");

  useEffect(() => {
    if (!isAuthLoaded || !organizationList.isLoaded || didRun.current) {
      return;
    }
    didRun.current = true;

    if (!isSignedIn) {
      window.location.replace(DESKTOP_AUTH_START_PATH);
      return;
    }

    const setActive = organizationList.setActive;
    if (!setActive) {
      setError("Desktop sign-in failed.");
      return;
    }

    async function completeTokenHandoff(): Promise<void> {
      if (!orgId) {
        const memberships = organizationList.userMemberships.data ?? [];
        if (memberships.length !== 1) {
          window.location.replace(desktopAuthSelectOrgPath(handoffId));
          return;
        }
        const membership = memberships[0];
        if (!membership) {
          window.location.replace(desktopAuthSelectOrgPath(handoffId));
          return;
        }
        await setActive({
          organization: membership.organization.id,
        });
      }

      const token = await completeDesktopAuth(getToken);
      if (handoffId) {
        await completeDesktopAuthHandoff(token, handoffId);
      }
      window.location.replace("/");
    }

    completeTokenHandoff().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : "Desktop sign-in failed.");
    });
  }, [getToken, handoffId, isAuthLoaded, isSignedIn, organizationList, orgId]);

  if (error) {
    return (
      <p style={{ padding: "2rem", fontFamily: "monospace" }}>Error: {error}</p>
    );
  }

  return (
    <p style={{ padding: "2rem", fontFamily: "monospace" }}>Signing in...</p>
  );
}
