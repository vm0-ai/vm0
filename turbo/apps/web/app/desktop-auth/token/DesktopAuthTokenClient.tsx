"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth, useOrganizationList } from "@clerk/nextjs";

import { completeDesktopAuth } from "../completeDesktopAuth";

const DESKTOP_AUTH_START_PATH = "/desktop-auth/start";
const DESKTOP_AUTH_SELECT_ORG_PATH = "/desktop-auth/select-org";

export function DesktopAuthTokenClient() {
  const { getToken, isLoaded: isAuthLoaded, isSignedIn, orgId } = useAuth();
  const organizationList = useOrganizationList({
    userMemberships: { pageSize: 100 },
  });
  const [error, setError] = useState("");
  const didRun = useRef(false);

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
          window.location.replace(DESKTOP_AUTH_SELECT_ORG_PATH);
          return;
        }
        const membership = memberships[0];
        if (!membership) {
          window.location.replace(DESKTOP_AUTH_SELECT_ORG_PATH);
          return;
        }
        await setActive({
          organization: membership.organization.id,
        });
      }

      await completeDesktopAuth(getToken);
      window.location.replace("/");
    }

    completeTokenHandoff().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : "Desktop sign-in failed.");
    });
  }, [getToken, isAuthLoaded, isSignedIn, organizationList, orgId]);

  if (error) {
    return (
      <p style={{ padding: "2rem", fontFamily: "monospace" }}>Error: {error}</p>
    );
  }

  return (
    <p style={{ padding: "2rem", fontFamily: "monospace" }}>Signing in...</p>
  );
}
