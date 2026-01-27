# Local Webhook Testing with Cloudflare Tunnel

This guide explains how to test E2B webhook callbacks locally during development without deploying to staging or production.

## Problem

When developing VM0 locally, E2B sandboxes run in the cloud and cannot reach `localhost` to send webhook events. This creates a slow feedback loop where you must deploy to staging/production to test webhook-dependent features.

## Solution

The web app dev server **automatically starts a Cloudflare Tunnel** to expose your local dev server through a temporary public HTTPS URL that E2B sandboxes can reach.

```
┌─────────────────────────────────────────────────────────────┐
│  Local Devcontainer                                         │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Next.js (localhost:3000) ← Cloudflare Tunnel         │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                           ↑
                           │ HTTPS
                           │
┌─────────────────────────────────────────────────────────────┐
│  E2B Cloud Sandbox                                          │
│  → Sends webhooks to https://random.trycloudflare.com      │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Start Dev Server

```bash
cd turbo
pnpm dev
```

The web app will automatically:

1. Start Cloudflare Tunnel
2. Get a public HTTPS URL (e.g., `https://random.trycloudflare.com`)
3. Set `VM0_API_URL` to the tunnel URL
4. Start Next.js dev server
5. Display webhook endpoint URL

**Note**: The web app takes ~15 seconds longer to start than other packages due to tunnel setup. Other packages (docs, platform, cli, etc.) start immediately in parallel.

### 2. Test with E2B Agent

In another terminal:

```bash
vm0 run my-agent "Analyze this codebase"
```

You'll see webhook events streaming in real-time!

```
container_start
init
text: "I'll analyze the codebase..."
tool_use: bash
tool_result: ...
result: ...
```

## What Happens Under the Hood

1. **Tunnel Creation**: `cloudflared` creates a temporary tunnel with HTTP/2 protocol
2. **URL Extraction**: Script waits for and extracts the public URL from tunnel logs
3. **Environment Setup**: `VM0_API_URL` is set to the tunnel URL
4. **Dev Server Start**: Next.js starts with the tunnel URL configured
5. **Webhook Flow**:
   - E2B sandbox receives `VM0_API_URL=https://tunnel-url.trycloudflare.com`
   - Sandbox constructs webhook URL: `${VM0_API_URL}/api/webhooks/agent/events`
   - Sandbox sends webhook events through the tunnel
   - Events reach your local dev server
   - Events are authenticated and stored in local database

## Output

When you run `pnpm dev`, you'll see tunnel info in the web app output:

```
[tunnel] Starting Cloudflare Tunnel...
[tunnel] Waiting for tunnel URL (this may take 10-15 seconds)...

[tunnel] Tunnel URL: https://example-name-random.trycloudflare.com
[tunnel] Webhooks: https://example-name-random.trycloudflare.com/api/webhooks/agent-events
```

Then the Next.js dev server starts normally.

## Stopping the Servers

Press `Ctrl+C` to stop all servers. The cleanup handler will automatically stop the cloudflared tunnel process.

## Troubleshooting

### Port 3000 Already in Use

**Error**: Port 3000 is already in use

**Solution**: Stop any running dev servers:

```bash
# Find and kill processes on port 3000
lsof -ti:3000 | xargs kill -9
```

### Tunnel URL Not Accessible

**Issue**: Tunnel URL returns errors when accessed externally

**Reasons**:

- Tunnel may take 15-20 seconds to become fully accessible
- This is normal behavior for temporary tunnels

**Solution**: Wait a bit longer, the script already includes appropriate wait times

### Cloudflared Not Found

**Error**: `cloudflared not found!`

**Solution**: Rebuild your devcontainer:

1. Open VS Code Command Palette (`Cmd/Ctrl+Shift+P`)
2. Select "Dev Containers: Rebuild Container"
3. Wait for rebuild to complete
4. Try `pnpm dev` again

### Webhook Events Not Appearing

**Check these**:

1. **Verify tunnel is running**:

   ```bash
   ps aux | grep cloudflared
   ```

2. **Check tunnel logs**:

   ```bash
   tail -f /tmp/cloudflared-dev.log
   ```

3. **Verify VM0_API_URL is set**:

   ```bash
   # In the dev server terminal, you should see it in the output
   ```

4. **Test webhook endpoint manually**:
   ```bash
   # Replace with your tunnel URL
   curl -X POST https://your-tunnel.trycloudflare.com/api/webhooks/agent/events \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer test-token" \
     -d '{"runId": "test", "events": [{"type": "init"}]}'
   ```

## Important Notes

### Tunnel URL Changes

- **Behavior**: Each time you run `pnpm dev`, a **new** tunnel URL is generated
- **Example**: `https://different-random-name.trycloudflare.com`
- **Why**: TryCloudflare creates temporary tunnels without requiring an account
- **Impact**: This is fine! The script automatically sets the new URL each time

### HTTP/2 Protocol

The script uses `--protocol http2` flag for cloudflared because:

- HTTP/2 works reliably in devcontainer environments
- QUIC (default) fails with connection timeouts
- This was discovered during POC testing

### Security

- **Tunnel is temporary**: Automatically deleted when script stops
- **Authentication preserved**: Bearer tokens work through the tunnel
- **HTTPS by default**: Cloudflare provides automatic SSL
- **No sensitive data exposure**: Only webhook endpoints are accessible

## Advanced Usage

### View Logs in Real-Time

**Tunnel logs**:

```bash
tail -f /tmp/cloudflared-dev.log
```

### Manual Tunnel (Advanced)

If you need more control, you can run the tunnel manually:

```bash
# Start tunnel
cloudflared tunnel --url http://localhost:3000 --protocol http2

# Copy the tunnel URL from output
# Set environment variable
export VM0_API_URL=https://your-tunnel-url.trycloudflare.com

# Start dev server in another terminal
cd turbo/apps/web
VM0_API_URL=$VM0_API_URL npx next dev --turbopack --port 3000
```

## Benefits

- **Fast feedback**: Test webhooks in seconds, not minutes
- **Easy debugging**: Set breakpoints and debug webhook handlers locally
- **Cost savings**: No unnecessary staging deployments
- **Complete workflow**: Test end-to-end E2B flows locally
- **Productivity**: Iterate quickly on webhook-dependent features

## Related

- Issue: [#102 - Enable E2B Webhook Callbacks in Local Development](https://github.com/vm0-ai/vm0/issues/102)
- Issue: [#1726 - Integrate Cloudflare tunnel into pnpm dev automatically](https://github.com/vm0-ai/vm0/issues/1726)
- Cloudflare Tunnel Docs: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/
