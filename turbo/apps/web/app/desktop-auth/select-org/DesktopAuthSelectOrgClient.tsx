"use client";

import { useEffect, useState } from "react";
import { useAuth, useOrganizationList } from "@clerk/nextjs";

import { completeDesktopAuth } from "../completeDesktopAuth";

const DESKTOP_AUTH_START_PATH = "/desktop-auth/start";

interface DesktopAuthSelectOrgClientProps {
  readonly forceSelection: boolean;
}

export function DesktopAuthSelectOrgClient({
  forceSelection,
}: DesktopAuthSelectOrgClientProps) {
  const { getToken, isLoaded: isAuthLoaded, isSignedIn, orgId } = useAuth();
  const organizationList = useOrganizationList({
    userMemberships: { pageSize: 100 },
  });
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [error, setError] = useState("");

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
        .then(() => {
          window.location.replace("/");
        })
        .catch((err: unknown) => {
          setError(
            err instanceof Error ? err.message : "Desktop sign-in failed.",
          );
        });
    }
  }, [forceSelection, getToken, isAuthLoaded, isSignedIn, orgId]);

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
      <p style={{ padding: "2rem", fontFamily: "monospace" }}>Error: {error}</p>
    );
  }

  if (!isAuthLoaded || !organizationList.isLoaded) {
    return (
      <p style={{ padding: "2rem", fontFamily: "monospace" }}>Signing in...</p>
    );
  }

  const memberships = organizationList.userMemberships.data ?? [];
  if (memberships.length === 0) {
    return (
      <p style={{ padding: "2rem", fontFamily: "monospace" }}>
        No workspaces are available.
      </p>
    );
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        padding: "2rem",
        fontFamily:
          'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        background: "#f8fafc",
        color: "#111827",
      }}
    >
      <section
        style={{
          maxWidth: "28rem",
          margin: "4rem auto",
          display: "grid",
          gap: "1rem",
        }}
      >
        <h1 style={{ margin: 0, fontSize: "1.5rem", lineHeight: 1.25 }}>
          Select workspace
        </h1>
        <div style={{ display: "grid", gap: "0.75rem" }}>
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
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  minHeight: "3.25rem",
                  border: "1px solid #d1d5db",
                  borderRadius: "0.5rem",
                  padding: "0.75rem 1rem",
                  background: "#ffffff",
                  color: "#111827",
                  font: "inherit",
                  cursor: selectedOrgId === null ? "pointer" : "wait",
                }}
              >
                <span>{organization.name}</span>
                {selectedOrgId === organization.id ? (
                  <span style={{ color: "#64748b" }}>Signing in...</span>
                ) : null}
              </button>
            );
          })}
        </div>
      </section>
    </main>
  );
}
