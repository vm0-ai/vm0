# SSH access for owners and Agents

SSH is a standalone capability behind the default-off `SshAccess` (`sshAccess`)
feature switch. The switch is the only feature-eligibility gate; enabled
organizations do not need staff membership. Owner, Agent grant and Run
authorization checks remain mandatory. The Connectors entry and Agent control
are hidden while the switch is off; this delivery does not activate it. SSH uses neither connector
accounts nor connector permissions.

## Owner setup

Open **Connectors -> Remote access -> SSH** (`/settings/ssh`) to manage up to 64 hosts for your
current organization and user, without selecting or creating an Agent. The SSH
card uses the same presentation as connector cards: no hosts shows the service
description and add affordance; configured hosts show a compact host-count
footer instead. The count is configuration, not tested connectivity. It participates in
search and category navigation. Connection-status filters mean configured or
not configured for SSH; an Agent filter uses its independent SSH grant, even
when no hosts are configured. SSH never opens generic connector account or
permission dialogs.

Supply a display name, public hostname or IP, port, SSH username, and
private key with an optional passphrase. Credentials are write-only and stay
outside the sandbox. Preserve complete key material, including whitespace.
Use a least-privilege remote SSH user for the Agent's intended work.
The form clears credentials on submission, close and navigation; unsuccessful
submissions require entering them again.

`Configured` is not a connectivity test. Configuration does not establish an
SSH session. Use **Replace credentials** to rotate a key or passphrase; ordinary
metadata edits leave credentials unchanged. Host/port changes clear the learned
host identity. A stale generation is not retried: refresh and reopen the host
to review the current settings.

Enable the **SSH** row in **Agent -> Authorization**, alongside connector rows
with the same search and loading switch, not in Profile. The information tooltip
explains the all-host grant and accepted Run-lifetime cache window.
The management button opens the same global host page; adding a host does not
grant an Agent access. The grant covers
all current and future hosts belonging to that owner in that organization.
Another user, an organization admin who is not the Agent owner, and the Agent
itself cannot grant this access. It is not limited to chat-triggered Runs.

## Agent commands

```sh
okou ssh host list --json
okou ssh exec <connection-id> --command 'uname -a' --json
```

Use the exact UUID from the live inventory, not the display name or hostname.
List again after an unavailable or unknown ID; never invent IDs or automatically
replay a command whose effects are unknown.
The inventory requires a current running Run, its owned Agent, a current grant,
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
