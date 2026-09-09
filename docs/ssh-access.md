# SSH access for owners and Agents

SSH is a standalone capability behind the default-off `SshAccess` (`sshAccess`)
feature switch. The switch is the only feature-eligibility gate; enabled
organizations do not need staff membership. Owner, Agent grant and Run
authorization checks remain mandatory. The Connectors entry and Agent control
are hidden while the switch is off; this delivery does not activate it. SSH uses neither connector
accounts nor connector permissions.

## Owner setup

Open **Connectors -> Remote access -> SSH** (`/connectors/ssh`) to manage hosts for your
current organization and user, without selecting or creating an Agent. The SSH
card uses the same presentation as connector cards: no hosts shows the service
description and add affordance; configured hosts show a compact host-count
footer with **Add access** or **Used by** Agent authorization. The authorization
dialog lists your currently visible Agents with search and the same switches as
Connector access management, while writing only the standalone SSH grant API.
The count is configuration, not tested connectivity. It participates in
search and category navigation. Connection-status filters mean configured or
not configured for SSH; an Agent filter uses its independent SSH grant, even
when no hosts are configured. SSH never opens generic connector account or
permission dialogs.

The zero-host card enters `/connectors/ssh?add=1`. The page consumes this intent
once, checks the current inventory and opens **Add host** only if it is still
empty. Cancelling, refreshing, or receiving a notification does not reopen it.

The management page follows the Agent and Workflow detail-page layout, with
**Connectors / SSH** breadcrumbs on desktop and mobile. Use the Connectors
breadcrumb to return to the directory. Host management remains independent of
Agent grants.

Supply a display name, public hostname or IP, port, SSH username, and
private key with an optional passphrase. Paste the key or use **Choose file** in
Add host or Replace credentials to read a non-empty key file up to 64 KiB locally.
File selection does not upload anything; Save submits the existing credential
request. The browser does not parse the key format. Credentials are write-only and stay
outside the sandbox. Preserve complete key material, including whitespace.
Use a least-privilege remote SSH user for the Agent's intended work.
The form clears credentials on submission, close and navigation; unsuccessful
submissions require entering them again.

`Configured` is not a connectivity test. Configuration does not establish an
SSH session. Use **Replace credentials** to rotate a key or passphrase; ordinary
metadata edits leave credentials unchanged. Host/port changes clear the learned
host identity. A stale generation is not retried: the list refreshes automatically.
Reopen the host to review the current settings before saving again.

Enable the **SSH** row in **Agent -> Authorization**, alongside connector rows
with the same search and loading switch, not in Profile. The description explains
the all-host grant; there is no information tooltip, permission-sliders or
host-management button in that row. With no hosts, the SSH
row is hidden without clearing grants. Adding the first host automatically
authorizes all Agents currently visible to you, including other users' public
Agents in the same workspace. Host creation and these grants commit together.
Adding more hosts preserves manually disabled grants. Deleting every host and
adding one again repeats automatic authorization, just like connecting the first
Connector account; Agents created afterward are not automatically authorized.

You can grant or revoke your own SSH access for any currently visible Agent.
The grant covers all your current and future hosts in that workspace, only for
your Runs. An Agent's creator or another user does not receive your credentials
or your grant. Agents cannot grant themselves access. This is not limited to
chat-triggered Runs.

Chat's services popover shows SSH alongside configured Connectors, with the
same authorization switch and an enabled trigger icon, without a host-management
action. Manage hosts through the global SSH card.
Both the service list and trigger icons order built-in Connectors before SSH,
then custom Connectors. The trigger keeps its three-icon limit and existing
computer/browser slots; SSH no longer displaces built-in Connector icons.
It always uses that composer's Agent, including split-pane chats. No hosts hides
the SSH row; **Add connectors** offers the same zero-host setup entry.
Opening the popover refreshes SSH reads without dropping the last confirmed
display for the same user/workspace. Its switch waits for the refreshed result.
Changing owner discards that retained display, and each composer selects only
its own Agent's grant.

Owner API business errors use stable `SSH_*` codes. Platform translates them,
including recovery guidance for invalid input, duplicate endpoints, stale
generations and unavailable hosts/Agents. A failed read shows a localized load
error with **Retry**, distinct from feature unavailability. There is no persistent
Refresh button and background failures do not show raw server-message toasts.

Successful host and grant changes publish best-effort `ssh:changed` on the owner's
user channel with only `{ orgId }`. Learning a new host key also refreshes the
browser. Platform checks the workspace and invalidates host, summary and grant
reads; reconnect and foreground catch-up recover missed updates. These refreshes
do not close dialogs, clear unsaved keys or automatically grant access. Browser
notifications are separate from Runner authority invalidation and do not tighten
the accepted Run-lifetime cache window.

## Agent commands

```sh
okou ssh host list --json
okou ssh exec <connection-id> --command 'uname -a' --json
```

Use the exact UUID from the live inventory, not the display name or hostname.
List again after an unavailable or unknown ID; never invent IDs or automatically
replay a command whose effects are unknown.
The inventory requires a current running Run, an Agent visible to its user, a current grant,
and `ssh:read`. An authorized empty inventory is distinct from unavailable
authority. Execution requires `ssh:write`. Both capabilities are minted only
for feature-enabled Runs; newly eligible Runs must start with a fresh token.
These commands are Run-only, not PAT commands. Agents cannot grant themselves
access or send target addresses, credentials or host keys to the helper.

The CLI sends exactly one version-1 `ssh.exec` request to the fixed packaged
`/usr/local/bin/runner-rpc-client`, with no shell, extra arguments or retry.
Commands must contain 1–65,536 UTF-8 bytes. Human output preserves binary
stdout/stderr; JSON exposes `stdout_base64`, `stderr_base64`, byte counts,
truncation flags and the structured outcome. Each output stream retains at most
1 MiB. No status, malformed output, duplicate terminal, lost transport or helper
exit zero without a valid SSH result counts as remote success.

`finished` carries a remote status or standard signal and `effects: completed`.
The CLI returns remote statuses 0–255 directly. Larger u32 statuses remain exact
in JSON and cause CLI exit 1. Signals also cause CLI exit 1. `failed` carries
`failure_reason` and `effects: not_started | unknown`. Generic helper failures
use `type: rpc_error`, `code` and `delivery: not_dispatched | unknown`. Diagnose
using these fields, never by matching error text. An uncertain result may have
performed the remote command: do not automatically retry it.

## Host identity, errors and revocation

The first successful connection learns and persists the server key before
authentication (TOFU). A learned key is read-only. For `host_key_mismatch`,
independently verify the new identity before using **Reset host key**; that
explicit confirmation allows a later connection to trust and learn a new key.
Never reset automatically. For credential failures, ask the owner to review the
supported key format and replace credentials. For `unavailable`, check the
feature, owner grant, host and Run lifetime. For `unsafe_destination` or
`network_failure`, check the public endpoint and reachability. Capacity or
timeout failures do not justify replay when effects are unknown.

Inventory and owner configuration are live reads. Execution authority uses the
existing Run-lifetime Runner cache while notifications are connected. Host edits,
rotation, deletion, reset and Agent grant changes publish invalidation notices.
Grant notices use `{ runId, connectionId: null }` for active Runs of that exact
owner/Agent, including after deleting the grant. Notification failure does not
roll back a committed edit. A missed notice can leave cached authority until the
Run ends. End affected active Runs when immediate revocation is necessary.

See [Runner authority](runner-ssh-authority.md) for authorization and cache
semantics, [SSH execution](runner-ssh-execution.md) for supported keys, network
policy and resource limits, and [RPC transport](runner-rpc-transport.md) for
packaged-helper framing, deadlines and deployment constraints.
