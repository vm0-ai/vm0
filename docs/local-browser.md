# Local Browser Rollout Guide

Local Browser is a connector-first path that lets Zero use a browser host owned
by the signed-in user. The host is expected to be a browser extension or
extension-backed local runtime that pairs with Zero, keeps an online heartbeat,
and executes only the commands approved by the API flow.

This guide tracks the current rollout surface for issue #13234: installation,
pairing, permissions, troubleshooting, and the security model. It is written for
engineers and operators shipping the staff-only rollout.

## Current State

- The connector type is `local-browser`.
- The rollout gate is `FeatureSwitchKey.LocalBrowserUse`, backed by the
  `localBrowserUse` switch.
- The switch is disabled globally and enabled for staff org hashes by default.
- The connector is strict-gated by the feature flag, so hidden connector cards do
  not appear when the switch is off.
- The feature switch is a rollout gate, not an authorization boundary. Routes
  still need normal auth, org scoping, host-token checks, and capability checks.
- There is no OAuth app. The connector uses the `api` auth method and a
  user-authorized local browser host.
- Public extension distribution is not complete in this repo. Until Chrome Web
  Store packaging exists, installation is an internal extension-build step.

## Install

During the staff-only rollout, install the internal Zero Local Browser extension
or host runtime that implements the local-browser runtime contract.

The installed host must send these fields when it starts pairing or refreshes a
heartbeat:

| Field                   | Meaning                                        |
| ----------------------- | ---------------------------------------------- |
| `hostName`              | User-visible host name, such as `Desk Chrome`. |
| `browser`               | Browser identifier, such as `chrome`.          |
| `extensionVersion`      | Installed extension or runtime version.        |
| `supportedCapabilities` | Command kinds the host can execute.            |

Supported read command kinds:

- `tabs.list`
- `tabs.current`
- `page.snapshot`
- `page.screenshot`
- `page.selection`
- `page.metadata`

Supported approved-write command kinds:

- `page.click`
- `page.type`
- `page.scroll`
- `page.navigate`
- `tabs.activate`
- `tabs.open`
- `tabs.close`

Before public rollout, publish the extension packaging, signing, update, and
review checklist. The product UI should not advertise a public install path
until that checklist exists.

## Pairing Flow

1. The extension starts pairing with
   `POST /api/zero/local-browser/device/start`.
2. The API returns a `userCode`, `verificationPath`, `pollToken`, expiry, poll
   interval, and optionally a realtime subscription for approval events.
3. The user signs in to Zero and opens the returned
   `/zero/connectors/local-browser` verification path.
4. The user enters the code. The claim request requires an authenticated org and
   `FeatureSwitchKey.LocalBrowserUse`.
5. The API binds the device code to the current `orgId` and `userId`.
6. The extension polls `POST /api/zero/local-browser/device/poll`.
7. After approval, the poll response returns a `hostId` and one-time-visible
   `hostToken`.
8. The extension stores the host token locally and uses it as
   `Authorization: Bearer <hostToken>` for host runtime endpoints.

Device codes expire after 15 minutes. Host tokens are stored server-side only as
hashes and are invalid after revocation.

## Connect Flow

Pairing creates a linked host, but connecting the Zero connector is a separate
step.

1. The host must send heartbeats to `POST /api/zero/local-browser/heartbeat`.
2. A host is considered online only while it has a recent heartbeat. The current
   offline threshold is 90 seconds.
3. The user connects `local-browser` from the connector settings UI.
4. `POST /api/zero/connectors/local-browser` succeeds only when the feature is
   enabled and at least one linked host is online.
5. The API creates or refreshes the `local-browser` connector row with
   `authMethod: "api"` and `needsReconnect: false`.

The generic connector card currently provides the baseline connect/disconnect
surface. The dedicated product surface for host status, install state, pending
actions, and extension controls remains part of #13234.

## Host Lifecycle

Linked hosts are scoped to a single org and user.

- Host status is derived from `status`, `lastSeenAt`, and the 90-second online
  window.
- The extension can request a realtime token from
  `POST /api/zero/local-browser/host/realtime-token` to wake up on command
  notifications.
- The extension claims executable work from
  `POST /api/zero/local-browser/host/commands/next`.
- The extension completes work with
  `POST /api/zero/local-browser/host/commands/:commandId/complete`.
- A signed-in user can list hosts with
  `zero local-browser hosts list`.
- A signed-in user can revoke a host with
  `zero local-browser hosts revoke <host-id>`.
- The extension can revoke its own current token with
  `DELETE /api/zero/local-browser/host`.

Revocation removes the host from the active host list and invalidates future
heartbeats, command claims, realtime token requests, and completions for that
host token.

## Permissions

Zero capabilities are split by read and write behavior:

| Capability            | Allows                                                   |
| --------------------- | -------------------------------------------------------- |
| `local-browser:read`  | Create read-only commands and read command results.      |
| `local-browser:write` | Create approved-write commands and read command results. |

Read commands are queued immediately when the connector is connected and a
capable online host exists.

Write commands are created as `pending_approval`. A signed-in user must approve
or deny them through
`POST /api/zero/local-browser/commands/:commandId/approval` before any host can
claim them. Denied commands fail with `permission_denied`.

Command result reads reject plain sandbox tokens. Zero run tokens must include
`local-browser:read` or `local-browser:write`; normal signed-in sessions and PATs
must still match the org and user.

## CLI

The user-facing inspection and smoke-test surface is:

```bash
zero local-browser hosts list
zero local-browser hosts revoke <host-id>
zero local-browser tabs list
zero local-browser tabs current
zero local-browser page snapshot
zero local-browser page screenshot
zero local-browser page selection
zero local-browser page metadata
zero local-browser page click --selector button
zero local-browser page type --selector input --text "hello"
zero local-browser page scroll --direction down --amount 600
zero local-browser tabs open --url https://example.com
zero local-browser audit list
```

Use `--host <name>` or `--host-id <id>` when more than one host is linked. Use
`--json` on host and audit list commands for automation.

For local development against a non-default API, set:

```bash
VM0_API_BACKEND_URL=http://localhost:3000
```

## Audit Events

Audit events are written for approved-write commands.

Tracked event names:

- `created`
- `approved`
- `denied`
- `completed`

Each event can include the command id, run id, host id, tab id, command kind,
target URL, approval outcome, redacted result, error, and timestamp.

Operators can inspect them with:

```bash
zero local-browser audit list
zero local-browser audit list --command-id <command-id>
zero local-browser audit list --host-id <host-id>
zero local-browser audit list --run-id <run-id>
zero local-browser audit list --limit 200 --json
```

Audit events are scoped by the signed-in org and user. They are intended for
debugging and reviewing local-browser write activity during rollout.

## Troubleshooting

| Symptom                                                                          | Likely cause                                                | Action                                                                     |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| `Local browser use is not enabled`                                               | `localBrowserUse` is off for the user or org.               | Enable the feature switch for the rollout target.                          |
| Device code approval fails with `Device code expired`                            | The 15-minute pairing window elapsed.                       | Start pairing again from the extension.                                    |
| Connector connect returns `Start an online local-browser host before connecting` | No linked host has a recent heartbeat.                      | Open the extension, check network access, and wait for heartbeat.          |
| `No linked local-browser host found`                                             | The user has no active host rows.                           | Pair the extension again.                                                  |
| `No online local-browser host found`                                             | Hosts exist but are offline or stale.                       | Restart the extension and confirm heartbeats arrive within 90 seconds.     |
| `Multiple local-browser hosts have this name`                                    | A command targeted `--host` and names are not unique.       | Use `--host-id` instead.                                                   |
| `No online local-browser host supports this command`                             | The host did not advertise the requested command kind.      | Update the extension or target another host.                               |
| `permission_denied`                                                              | The user denied an approved-write command.                  | Treat as an intentional denial and do not retry without a new user action. |
| Command timeout                                                                  | The host did not claim or complete work before the timeout. | Check realtime subscription, host logs, and heartbeat status.              |
| Host token becomes invalid                                                       | The host was revoked or the stored token was lost.          | Pair again to mint a new host token.                                       |

## Security Model

- The connector does not store OAuth credentials.
- Device start and poll are unauthenticated, but approval requires a signed-in
  org user with the rollout switch enabled.
- Device approval binds the code to exactly one org and user.
- Host tokens are opaque bearer tokens. The API stores only hashes.
- Host tokens authenticate only host runtime endpoints.
- User and org scoped routes never return hosts, commands, or audit events from
  another org/user.
- Read and write capabilities are separate Zero capabilities.
- Write commands require explicit approval before a host can claim them.
- Revocation sets `revokedAt` and makes future host-token use fail.
- Audit records are written for write command creation, approval, denial, and
  completion.

## Rollout Checklist

- Keep `FeatureSwitchKey.LocalBrowserUse` disabled globally.
- Start with staff orgs only.
- Verify pairing, heartbeat, host list, connector connect, read command, write
  approve, write deny, audit list, and revoke flows.
- Confirm zero tokens only include local-browser capabilities when the feature is
  enabled.
- Confirm command result reads reject sandbox tokens without local-browser
  capabilities.
- Add product UI for install state, paired hosts, online/offline status, pending
  write approvals, pause/stop, and revoke.
- Add logs and metrics for pair success, online hosts, command latency, command
  failure kind, and user-denied actions.
- Finish Chrome Web Store packaging, signing, update, and review checklist before
  public rollout.
