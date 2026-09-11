# Read-only source-key usage evidence

Dispatch **KMS Production Preflight** on protected `main` with
`operation=source-audit`. Its existing production environment approval and
Doppler OIDC identity apply. This operation does not need a deployment ID;
the default `verify` operation still requires one in the script.

The audit reads the existing checksum- and provenance-verified rollback snapshot
in memory, verifies the source account and runtime principal through STS, then
calls only `cloudtrail:LookupEvents` in `us-west-2`. It does not run KMS canaries,
connect to a database, fetch a Vercel deployment, change credentials or modify
resources. The retained source principal must already have permission to read
CloudTrail event history; an access denial produces an incomplete report.

Both full key ARN and short key ID queries cover the accepted migration
verification time, `2026-09-10T07:38:23.484Z`, through 15 minutes before the audit.
Each query uses explicit bounded pagination and the combined result deduplicates
event IDs. The visibility buffer does not guarantee that all delayed events have
arrived. The command fails closed when its start falls outside CloudTrail's
90-day event-history window.

The existing sanitized verification artifact contains `source-audit.json` with
query coverage, event counts, allowlisted operation names, event times, error
presence, hashed principal identifiers, and whether an event used the retained
source credential. Provider payloads, access keys, names, request parameters and
pagination tokens are not exported. A successful collection does not establish
retirement clearance: recent cryptographic or unclassified calls still need
review, along with current production ciphertext, runner state and retained
backup/recovery dependencies. `retirementCleared` remains false.
