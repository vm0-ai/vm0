// Temporarily hard-disabled: the previous implementation reached
// `globalThis.services.db` via `getUserFeatureSwitches`, but the marketing
// SSR entry points (app/[locale]/layout.tsx → SiteHeader) never call
// `initServices()`. For signed-in users with an active org this crashed every
// `/{locale}/*` page render with `TypeError: Cannot read properties of
// undefined (reading 'db')`. Returning false unconditionally hides the docs
// nav and 404s `/docs` routes until the SSR services bootstrap is fixed.
export async function canViewDocsForUser(
  _userId: string | null | undefined,
  _orgId: string | null | undefined,
): Promise<boolean> {
  return false;
}

export async function canViewDocs(): Promise<boolean> {
  return false;
}
