# App Environment Configuration
# Use 1Password CLI to inject secrets: ./scripts/sync-env.sh
VITE_CLERK_PUBLISHABLE_KEY=op://Development/clerk/CLERK_PUBLISHABLE_KEY
VITE_API_URL=http://localhost:3000
PUBLIC_ARTIFACTS_BASE_URL=https://cdn.vm7.io
VITE_ZERO_HOST_DOMAIN=sites.vm7.io

# Web Push (VAPID public key for push subscription)
VITE_VAPID_PUBLIC_KEY=op://Development/vapid/VAPID_PUBLIC_KEY

# Analytics
VITE_PLAUSIBLE_SCRIPT_URL=
VITE_POSTHOG_KEY=

# Optional: Error Tracking (Sentry)
VITE_SENTRY_DSN=
SENTRY_AUTH_TOKEN=
SENTRY_ORG=
SENTRY_PROJECT=
