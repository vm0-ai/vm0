const BROWSER_CONNECTOR_REF = "browser";
const BROWSER_WRITE_CAPABILITY = "browser:write";

export function isBrowserPermissionTarget(args: {
  readonly connectorRef: string;
  readonly permission: string;
}): boolean {
  return (
    args.connectorRef === BROWSER_CONNECTOR_REF ||
    args.permission === BROWSER_WRITE_CAPABILITY
  );
}

export function printBrowserPermissionGuidance(): void {
  console.log(
    "Cloud browser access is controlled by the current chat thread, not a connector grant.",
  );
  console.log(
    "Enable Cloud browser under Your computer in the chat composer, then start a new run. Existing run tokens cannot be upgraded in place.",
  );
}
