// The early bootstrap script in index.html picks the Clerk publishable key for
// the serving hostname and records it on the document element, so one app
// artifact works across preview and production.
//
// This module is page-only on purpose. Keeping it out of platform-host.ts is
// what lets that module stay free of DOM globals, which matters because the
// shared database worker imports it.
const CLERK_PUBLISHABLE_KEY_ATTRIBUTE = "data-vm0-clerk-publishable-key";

export function resolveClerkPublishableKey(): string {
  const publishableKey = document.documentElement.getAttribute(
    CLERK_PUBLISHABLE_KEY_ATTRIBUTE,
  );
  if (!publishableKey) {
    throw new Error("Missing Clerk publishable key from platform bootstrap");
  }
  return publishableKey;
}
