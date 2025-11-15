---
command: dev-start
description: Start the development server in background mode
---

Starts the Turbo development server in the background with stream UI mode. If a dev server is already running, it will be stopped first.

Usage: `/dev-start`

## What to do:

1. **Stop any running dev server:**
   ```bash
   # List all background bash shells to find dev server
   # Look for shells running "pnpm dev"
   ```

   For each dev server shell found:
   - Use `KillShell({ shell_id: "<id>" })` to stop it
   - Wait 2 seconds for processes to fully terminate

2. **Generate SSL certificates if needed:**
   Check if certificates exist, generate if missing:
   ```bash
   # Get project root dynamically
   PROJECT_ROOT=$(git rev-parse --show-toplevel)
   CERT_DIR="$PROJECT_ROOT/.certs"

   # Check if all required certificates exist
   if [ ! -f "$CERT_DIR/www.uspark.dev.pem" ] || \
      [ ! -f "$CERT_DIR/app.uspark.dev.pem" ] || \
      [ ! -f "$CERT_DIR/docs.uspark.dev.pem" ] || \
      [ ! -f "$CERT_DIR/uspark.dev.pem" ]; then
     # Use the generate-certs script
     bash "$PROJECT_ROOT/scripts/generate-certs.sh"
   else
     echo "✅ SSL certificates already exist"
   fi
   ```

3. **Start dev server in background:**
   Use Bash tool with `run_in_background: true`:
   ```bash
   PROJECT_ROOT=$(git rev-parse --show-toplevel)
   cd "$PROJECT_ROOT/turbo" && pnpm dev --ui=stream
   ```

4. **Show the shell ID:**
   Display the shell_id returned by the Bash tool so user knows which process to monitor.

5. **Show next steps:**
   ```
   ✅ Dev server started in background (shell_id: <id>)

   Next steps:
   - Use `/dev-logs` to view server output
   - Use `/dev-logs [pattern]` to filter logs (e.g., `/dev-logs error`)
   - Use `/dev-stop` to stop the server
   ```

Note: The `--ui=stream` flag ensures non-interactive output suitable for background monitoring.
