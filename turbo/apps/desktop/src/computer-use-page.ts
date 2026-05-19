export const COMPUTER_USE_FEATURE_SWITCH_KEY = "computerUse";

export interface ComputerUsePermissionState {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
}

interface ComputerUseHostPageState {
  readonly status: string;
  readonly hostId: string | null;
  readonly lastHeartbeatAt: string | null;
  readonly lastCommandAt: string | null;
  readonly lastError: string | null;
  readonly pendingApprovals: readonly ComputerUsePendingApprovalPageState[];
  readonly recentAuditEvents: readonly ComputerUseAuditEventPageState[];
}

interface ComputerUsePendingApprovalPageState {
  readonly commandId: string;
  readonly kind: string;
  readonly app: string | null;
  readonly createdAt: string;
}

interface ComputerUseAuditEventPageState {
  readonly commandId: string;
  readonly kind: string;
  readonly app: string | null;
  readonly event: string;
  readonly approvalOutcome: string | null;
  readonly createdAt: string;
}

interface ComputerUsePageState {
  readonly featureSwitchKey: typeof COMPUTER_USE_FEATURE_SWITCH_KEY;
  readonly approvalActionScheme: string;
  readonly permissions: ComputerUsePermissionState;
  readonly host: ComputerUseHostPageState;
}

export interface ComputerUseApprovalAction {
  readonly commandId: string;
  readonly decision: "approve" | "deny";
}

function escapeHtml(value: string): string {
  let escaped = "";
  for (const char of value) {
    if (char === "&") {
      escaped += "&amp;";
    } else if (char === "<") {
      escaped += "&lt;";
    } else if (char === ">") {
      escaped += "&gt;";
    } else if (char === '"') {
      escaped += "&quot;";
    } else {
      escaped += char;
    }
  }
  return escaped;
}

function statusText(enabled: boolean): string {
  return enabled ? "Granted" : "Needs setup";
}

function statusClass(enabled: boolean): string {
  return enabled ? "ok" : "warn";
}

function hostStatusClass(status: string): string {
  return status === "online" ? "ok" : "warn";
}

function valueText(value: string | null): string {
  return value ? escapeHtml(value) : "None";
}

export function buildComputerUseApprovalActionUrl(args: {
  readonly scheme: string;
  readonly commandId: string;
  readonly decision: ComputerUseApprovalAction["decision"];
}): string {
  const url = new URL(`${args.scheme}://computer-use/approval`);
  url.searchParams.set("commandId", args.commandId);
  url.searchParams.set("decision", args.decision);
  return url.toString();
}

export function parseComputerUseApprovalActionUrl(
  rawUrl: string,
  scheme: string,
): ComputerUseApprovalAction | null {
  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== `${scheme}:` ||
      url.hostname !== "computer-use" ||
      url.pathname !== "/approval"
    ) {
      return null;
    }

    const commandId = url.searchParams.get("commandId");
    const decision = url.searchParams.get("decision");
    if (!commandId || (decision !== "approve" && decision !== "deny")) {
      return null;
    }
    return { commandId, decision };
  } catch {
    return null;
  }
}

function commandTitle(command: {
  readonly commandId: string;
  readonly kind: string;
  readonly app: string | null;
}): string {
  const app = command.app ? ` · ${escapeHtml(command.app)}` : "";
  return `${escapeHtml(command.kind)}${app}`;
}

function renderPendingApprovals(
  approvals: readonly ComputerUsePendingApprovalPageState[],
  scheme: string,
): string {
  if (approvals.length === 0) {
    return '<p class="empty">No pending approvals</p>';
  }
  return `<ul>${approvals
    .map((approval) => {
      const approveUrl = buildComputerUseApprovalActionUrl({
        scheme,
        commandId: approval.commandId,
        decision: "approve",
      });
      const denyUrl = buildComputerUseApprovalActionUrl({
        scheme,
        commandId: approval.commandId,
        decision: "deny",
      });
      return `<li><strong>${commandTitle(approval)}</strong><span>${escapeHtml(approval.commandId)} · ${escapeHtml(approval.createdAt)}</span><div class="actions"><a class="approve" href="${escapeHtml(approveUrl)}">Approve</a><a class="deny" href="${escapeHtml(denyUrl)}">Deny</a></div></li>`;
    })
    .join("")}</ul>`;
}

function renderAuditEvents(
  auditEvents: readonly ComputerUseAuditEventPageState[],
): string {
  if (auditEvents.length === 0) {
    return '<p class="empty">No command history</p>';
  }
  return `<ul>${auditEvents
    .map((event) => {
      const outcome = event.approvalOutcome
        ? ` · ${event.approvalOutcome}`
        : "";
      return `<li><strong>${commandTitle(event)}</strong><span>${escapeHtml(event.event)}${escapeHtml(outcome)} · ${escapeHtml(event.createdAt)}</span></li>`;
    })
    .join("")}</ul>`;
}

export function buildComputerUsePageHtml(state: ComputerUsePageState): string {
  const accessibilityClass = statusClass(state.permissions.accessibility);
  const screenClass = statusClass(state.permissions.screenRecording);
  const hostClass = hostStatusClass(state.host.status);
  const approvalClass =
    state.host.pendingApprovals.length === 0 ? "ok" : "warn";
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Computer Use</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #19191b; color: #f4f4f5; }
      body { margin: 0; min-height: 100vh; display: flex; align-items: stretch; }
      main { width: min(840px, calc(100vw - 48px)); margin: 0 auto; padding: 40px 0; }
      h1 { margin: 0 0 10px; font-size: 28px; font-weight: 650; letter-spacing: 0; }
      p { margin: 0; color: #a1a1aa; line-height: 1.55; }
      section { border-top: 1px solid #303036; padding: 22px 0; }
      .intro { padding-bottom: 28px; }
      .row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; align-items: center; }
      .label { font-size: 15px; font-weight: 600; color: #fafafa; }
      .status { border-radius: 999px; padding: 5px 10px; font-size: 12px; font-weight: 650; }
      .ok { color: #bbf7d0; background: #14532d; }
      .warn { color: #fde68a; background: #713f12; }
      code { color: #d4d4d8; background: #27272a; border-radius: 5px; padding: 2px 5px; }
      .note { margin-top: 10px; font-size: 13px; }
      dl { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 10px 16px; margin: 14px 0 0; color: #d4d4d8; font-size: 13px; }
      dt { color: #a1a1aa; }
      dd { margin: 0; overflow-wrap: anywhere; }
      ul { list-style: none; margin: 14px 0 0; padding: 0; display: grid; gap: 10px; }
      li { display: grid; gap: 4px; padding: 10px 0; border-top: 1px solid #303036; }
      li strong { color: #fafafa; font-size: 13px; font-weight: 650; }
      li span, .empty { color: #a1a1aa; font-size: 12px; overflow-wrap: anywhere; }
      .actions { display: flex; gap: 8px; margin-top: 4px; }
      a { color: #fafafa; border-radius: 5px; padding: 5px 9px; font-size: 12px; font-weight: 650; text-decoration: none; }
      a.approve { background: #166534; }
      a.deny { background: #7f1d1d; }
    </style>
  </head>
  <body>
    <main>
      <div class="intro">
        <h1>Computer Use</h1>
        <p>Zero Desktop prepares this Mac for agent-driven app control through the Zero CLI. Server access is gated by <code>${escapeHtml(state.featureSwitchKey)}</code>.</p>
      </div>
      <section class="row">
        <div>
          <div class="label">Accessibility</div>
          <p class="note">Required for reading the macOS accessibility tree and targeting UI elements.</p>
        </div>
        <span class="status ${accessibilityClass}">${statusText(state.permissions.accessibility)}</span>
      </section>
      <section class="row">
        <div>
          <div class="label">Screen Recording</div>
          <p class="note">Required when app state includes screenshots for visual verification.</p>
        </div>
        <span class="status ${screenClass}">${statusText(state.permissions.screenRecording)}</span>
      </section>
      <section>
        <div class="row">
          <div>
            <div class="label">Host</div>
            <p class="note">Desktop registers this Mac with the Zero API command queue when the feature switch is enabled and the user is signed in.</p>
          </div>
          <span class="status ${hostClass}">${escapeHtml(state.host.status)}</span>
        </div>
        <dl>
          <dt>Host ID</dt><dd>${valueText(state.host.hostId)}</dd>
          <dt>Last heartbeat</dt><dd>${valueText(state.host.lastHeartbeatAt)}</dd>
          <dt>Last command</dt><dd>${valueText(state.host.lastCommandAt)}</dd>
          <dt>Last error</dt><dd>${valueText(state.host.lastError)}</dd>
        </dl>
      </section>
      <section>
        <div class="row">
          <div>
            <div class="label">Pending approvals</div>
            <p class="note">Write commands wait here before Desktop executes them.</p>
          </div>
          <span class="status ${approvalClass}">${state.host.pendingApprovals.length} pending</span>
        </div>
        ${renderPendingApprovals(state.host.pendingApprovals, state.approvalActionScheme)}
      </section>
      <section>
        <div class="label">Recent command history</div>
        ${renderAuditEvents(state.host.recentAuditEvents)}
      </section>
    </main>
  </body>
</html>`;
}

export function buildComputerUsePageUrl(state: ComputerUsePageState): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(
    buildComputerUsePageHtml(state),
  )}`;
}
