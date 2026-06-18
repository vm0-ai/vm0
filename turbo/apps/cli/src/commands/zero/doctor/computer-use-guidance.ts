const COMPUTER_USE_CONNECTOR_REF = "computer-use";
const COMPUTER_USE_CAPABILITY = "computer-use:write";
const COMPUTER_USE_PATH_PREFIX = "/computer-use";

interface ComputerUsePermissionTarget {
  readonly connectorRef: string;
  readonly path?: string;
  readonly permission?: string;
}

export function isComputerUsePermissionTarget(
  target: ComputerUsePermissionTarget,
): boolean {
  return (
    target.connectorRef === COMPUTER_USE_CONNECTOR_REF ||
    target.permission === COMPUTER_USE_CAPABILITY ||
    target.path?.startsWith(COMPUTER_USE_PATH_PREFIX) === true
  );
}

export function printComputerUsePermissionGuidance(): void {
  console.log("Computer Use access is not managed as a connector permission.");
  console.log(
    "The current run token needs computer-use:write, which is issued only when a Zero Desktop Computer Use host is selected for the chat or thread before the run starts.",
  );
  console.log(
    "Open Zero Desktop, make sure Computer Use is online, select the Computer Use host for this chat/thread, then start a new run. Existing run tokens cannot be upgraded in place.",
  );
  console.log(
    "Run `zero whoami` to confirm whether the current ZERO_TOKEN includes computer-use:write.",
  );
}
