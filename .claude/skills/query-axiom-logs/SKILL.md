---
name: Query Axiom Logs
description: Query logs from Axiom for debugging (read-only, no ingestion allowed)
---

# Query Axiom Logs

Query logs and telemetry data from Axiom for debugging purposes.

**IMPORTANT: This skill is READ-ONLY. Never ingest or write data to Axiom.**

## Environment Setup

### AXIOM_TOKEN Location

The token is stored in `turbo/apps/web/.env.local`:

```bash
AXIOM_TOKEN=xaat-xxxxx
```

### If Token is Missing

Ask the user to sync environment variables from 1Password:

```bash
./scripts/sync-env.sh
```

This syncs `AXIOM_TOKEN` from `op://Development/vm0-env-local/axiom_token`.

## Available Datasets

| Dataset | Dev Name | Purpose |
|---------|----------|---------|
| Web Logs | `vm0-web-logs-dev` | Server logs (errors, warnings, API calls) |
| Agent Run Events | `vm0-agent-run-events-dev` | Agent execution events and activity |
| Sandbox System | `vm0-sandbox-telemetry-system-dev` | Sandbox console/system logs |
| Sandbox Metrics | `vm0-sandbox-telemetry-metrics-dev` | CPU, memory, disk usage |
| Sandbox Network | `vm0-sandbox-telemetry-network-dev` | HTTP requests from sandbox |

For production, replace `-dev` with `-prod`.

## Query Command

```bash
source turbo/apps/web/.env.local && axiom query "APL_QUERY" -T "$AXIOM_TOKEN" -f table
```

Options:
- `-f table` - Human-readable table (default)
- `-f json` - JSON output for processing
- `--start-time "-1h"` - Filter by time range

## APL Query Syntax

```apl
['dataset-name']
| where condition
| project field1, field2
| limit 100
```

### Common Operators

| Operator | Example |
|----------|---------|
| Filter | `where level == "error"` |
| Search | `search "connection refused"` |
| Time | `where _time > now(-1h)` |
| Select | `project _time, message` |
| Sort | `sort by _time desc` |
| Limit | `limit 100` |
| Count | `summarize count() by field` |

## Common Queries

### Web Logs - Find Errors

```bash
source turbo/apps/web/.env.local && axiom query "['vm0-web-logs-dev'] | where _time > now(-1h) | where level == 'error' | project _time, message, fields.context | sort by _time desc | limit 50" -T "$AXIOM_TOKEN"
```

### Web Logs - Search Text

```bash
source turbo/apps/web/.env.local && axiom query "['vm0-web-logs-dev'] | search 'connection refused' | project _time, message | limit 20" -T "$AXIOM_TOKEN" --start-time "-24h"
```

### Agent Events - By Run ID

```bash
source turbo/apps/web/.env.local && axiom query "['vm0-agent-run-events-dev'] | where runId == 'UUID_HERE' | sort by sequenceNumber asc" -T "$AXIOM_TOKEN"
```

### Agent Events - Failed Runs

```bash
source turbo/apps/web/.env.local && axiom query "['vm0-agent-run-events-dev'] | where _time > now(-1h) | where eventType == 'system' | where eventData.subtype == 'error' | project _time, runId, eventData.message | limit 20" -T "$AXIOM_TOKEN"
```

### Sandbox Logs - By Run ID

```bash
source turbo/apps/web/.env.local && axiom query "['vm0-sandbox-telemetry-system-dev'] | where runId == 'UUID_HERE' | sort by _time asc" -T "$AXIOM_TOKEN"
```

### Sandbox Metrics - Resource Usage

```bash
source turbo/apps/web/.env.local && axiom query "['vm0-sandbox-telemetry-metrics-dev'] | where runId == 'UUID_HERE' | project _time, cpu, mem_used, disk_used | sort by _time asc" -T "$AXIOM_TOKEN"
```

### Sandbox Network - HTTP Errors

```bash
source turbo/apps/web/.env.local && axiom query "['vm0-sandbox-telemetry-network-dev'] | where _time > now(-1h) | where status >= 400 | project _time, method, url, status, latency_ms | limit 50" -T "$AXIOM_TOKEN"
```

## Dataset Fields Reference

### vm0-web-logs-dev

| Field | Description |
|-------|-------------|
| `_time` | Event timestamp |
| `level` | Log level (error, warn, info, debug) |
| `message` | Log message |
| `fields.context` | Context (webhook:complete, api:runs, etc.) |
| `vercel.environment` | Vercel env (preview, production) |
| `vercel.region` | Vercel region (iad1, etc.) |

### vm0-agent-run-events-dev

| Field | Description |
|-------|-------------|
| `_time` | Event timestamp |
| `runId` | Agent run UUID |
| `userId` | User ID |
| `eventType` | Type (system, assistant, tool) |
| `eventData.type` | Subtype details |
| `eventData.message` | Event message content |
| `sequenceNumber` | Event sequence in run |

### vm0-sandbox-telemetry-system-dev

| Field | Description |
|-------|-------------|
| `_time` | Event timestamp |
| `runId` | Agent run UUID |
| `userId` | User ID |
| `log` | Raw log text |

### vm0-sandbox-telemetry-metrics-dev

| Field | Description |
|-------|-------------|
| `_time` | Timestamp |
| `runId` | Agent run UUID |
| `cpu` | CPU usage (0-1) |
| `mem_total`, `mem_used` | Memory in bytes |
| `disk_total`, `disk_used` | Disk in bytes |

### vm0-sandbox-telemetry-network-dev

| Field | Description |
|-------|-------------|
| `_time` | Timestamp |
| `runId` | Agent run UUID |
| `method` | HTTP method |
| `url` | Request URL |
| `status` | HTTP status code |
| `latency_ms` | Latency in milliseconds |
| `request_size`, `response_size` | Bytes |

## Constraints

- Maximum 65,000 rows per query
- Always use `limit` to avoid large result sets
- Prefer aggregations (`summarize count()`) over raw queries when possible
