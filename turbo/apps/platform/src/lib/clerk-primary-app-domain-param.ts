// Worker URL parameter carrying the deployment's Clerk primary app domain. The
// value is substituted into index.html after the build, so only a tab can read
// it; the SharedWorker bundle is an immutable asset that has no copy of it.
export const CLERK_PRIMARY_APP_DOMAIN_PARAM = "clerkPrimaryAppDomain";
