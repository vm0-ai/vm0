# Zero Desktop migration rollout

This runbook controls the final Zero-to-Okou Desktop migration tracked by
[#26370](https://github.com/vm0-ai/vm0/issues/26370). Shipping the control code
does not authorize or activate a hard stop.

## Ownership

- The Desktop release owner owns the policy-capable Zero release and verifies
  that it reached the intended population.
- The API production owner owns the public policy endpoint and the policy
  publishing workflow.
- The support owner must be named in the approval comment before a hard stop.
- The person who publishes `hard` is also the rollback operator until the
  observation window ends.

Record the named people, evidence, decision, and rollback operator in a comment
on #26370. A production environment reviewer is the final deployment gate.

## Policy contract

The `Publish Zero Desktop Migration Policy` workflow publishes
`desktop-migration-policy.json` as a mutable asset on the
`desktop-migration-policy` GitHub release. The API exposes the validated policy
at `GET /api/desktop/migration-policy` with `Cache-Control: no-store`.

| Mode   | Desktop behavior                                                                           |
| ------ | ------------------------------------------------------------------------------------------ |
| `off`  | Keep Zero available and hide reminders.                                                    |
| `soft` | Keep Zero available and show the nonblocking Okou reminder.                                |
| `hard` | Finish the current command, stop the Zero host, and offer only Download Okou or Quit Zero. |

Eligible Zero builds refresh the policy every five minutes. The API and the
Desktop both independently fall back to `soft` when the policy is missing,
unavailable, timed out, or invalid. Okou ignores this policy. Zero versions
older than the minimum bridge version remain unaffected.

## Publishing a mode

Run the workflow from `main`:

```bash
gh workflow run desktop-migration-policy.yml \
  --ref main \
  -f mode=soft \
  -f confirmed_hard_stop=false
```

The workflow rejects dispatches from any ref other than `main`.

Then wait for the workflow to succeed and verify the live API response:

```bash
curl -fsSL https://api.vm0.ai/api/desktop/migration-policy | jq
```

Publishing `off` or `soft` does not require a Desktop or API release. Publishing
`hard` additionally requires `confirmed_hard_stop=true`, the URL of the explicit
approval comment on #26370, and production environment approval.

## Product-aware evidence

Use a bounded Axiom request-log query to distinguish active Desktop products and
versions. Start with 15 minutes, then expand to at most the three-day retention
window when assessing adoption:

```apl
where x_client_type == "Desktop"
| summarize requests=count(), sessions=dcount(x_client_session_id)
  by x_client_product, x_client_version
| sort by requests desc
```

Check policy delivery and errors separately:

```apl
where path_template == "/api/desktop/migration-policy"
| summarize requests=count(), failures=countif(status >= 500)
  by x_client_product, x_client_version, status
| sort by requests desc
```

Use MaskDB aggregates over `computer_use_hosts` to review recent host versions
and status without retrieving names or tokens:

```json
{
  "table": "computer_use_hosts",
  "where": {
    "col": "last_seen_at",
    "op": "gte",
    "value": "<UTC start of review window>"
  },
  "group_by": ["client_product", "app_version", "status"],
  "metrics": [{ "op": "count", "as": "hosts" }],
  "order_by": [{ "col": "hosts", "dir": "desc" }],
  "limit": 100
}
```

The MaskDB policy must expose `client_product` as a filterable group field before
the hard-stop review. If it does not, refreshing that read-only allowlist is a
go/no-go blocker; do not replace the masked-data review with raw production SQL.

## Hard-stop go/no-go checklist

All items must be recorded as satisfied on #26370 before publishing `hard`:

- [ ] Okou install, login, permissions, Computer Use, updater, and stable
      download flows remain production-verified.
- [ ] The policy-capable Zero stable release has been available for at least 72
      hours and represents at least 95% of active Zero Desktop sessions in the
      review window.
- [ ] Remaining external Zero users and versions have been reviewed from
      bounded Axiom and masked MaskDB evidence; impact is explicitly accepted.
- [ ] Okou adoption and error rates are healthy, with no unresolved migration,
      authentication, updater, or Computer Use regression.
- [ ] The support owner has current download, reinstall, permissions, and login
      guidance ready.
- [ ] The rollback operator is available for the activation and observation
      window.
- [ ] The approver has posted an explicit `hard` approval comment on #26370.

If any item is unknown or false, the decision is no-go and the policy stays
`soft`.

## Activation and rollback

Activate only during staffed hours. Publish `hard`, verify the live endpoint,
and observe policy requests, Zero/Okou active sessions, API failures, and support
reports for at least 30 minutes. Desktop clients can take up to five minutes to
apply a new policy.

For any unexpected impact, publish `soft` immediately with the same workflow and
verify the live endpoint. Running Zero clients poll back to coexistence and may
restart their host within five minutes. Use `off` instead when the reminder must
also disappear. Users who already quit Zero must reopen it to receive the
rollback policy. Record the rollback time, reason, and verification evidence on
#26370.
