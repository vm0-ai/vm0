# App Environment Configuration
# Use 1Password CLI to inject secrets: ./scripts/sync-env.sh
VITE_CLERK_PUBLISHABLE_KEY_PREVIEW=op://Development/clerk/CLERK_PUBLISHABLE_KEY
VITE_CLERK_PUBLISHABLE_KEY_PROD=op://Development/clerk/CLERK_PUBLISHABLE_KEY_PROD
VITE_API_URL=http://localhost:3000
PUBLIC_ARTIFACTS_BASE_URL=https://cdn.vm7.io

# Web Push (VAPID public key for push subscription)
VITE_VAPID_PUBLIC_KEY_PREVIEW=op://Development/vapid/VAPID_PUBLIC_KEY
VITE_VAPID_PUBLIC_KEY_PROD=

# Analytics
VITE_POSTHOG_KEY=
VITE_AXIOM_CLIENT_TELEMETRY_TOKEN=op://Development/axiom/AXIOM_CLIENT_TELEMETRY_TOKEN

# Optional: Error Tracking (Sentry)
VITE_SENTRY_DSN_PROD=
SENTRY_AUTH_TOKEN=
SENTRY_ORG=
SENTRY_PROJECT=
