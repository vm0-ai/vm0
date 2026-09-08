// eslint-disable-next-line no-restricted-imports -- This independent build entry is never imported by the application; bundle checks enforce that boundary.
import { ui } from "@clerk/ui";

// This separately built, route-scoped entry is never imported by main.ts.
// The application owns this handoff; Clerk's constructor comes from its public
// package export, not the CDN's internal constructor global.
window.__okouClerkUI = ui;
