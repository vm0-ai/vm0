---
command: cleanup-preview-envs
description: Clean up old GitHub preview deployment environments
---

Cleans up GitHub preview deployment environments that haven't had deployments in the last 3 days.

Usage: `/cleanup-preview-envs`

## What to do:

1. **List all preview environments:**
   ```bash
   gh api repos/:owner/:repo/environments --paginate -q '.environments[] | .name' 2>/dev/null | grep -i preview > /tmp/preview_envs.txt
   ```

2. **Count total preview environments:**
   ```bash
   wc -l < /tmp/preview_envs.txt
   ```

3. **Get latest deployment date for each preview environment:**
   ```bash
   gh api repos/:owner/:repo/deployments --paginate -q '.[] | select(.environment | test("preview")) | "\(.environment)|\(.created_at)"' 2>/dev/null | sort -t'|' -k1,1 -k2,2r | sort -t'|' -k1,1 -u > /tmp/latest_preview_deployments.txt
   ```

4. **Show preview environments to be deleted:**
   Calculate cutoff date (3 days ago) and show environments that will be deleted:
   ```bash
   cutoff=$(date -d "3 days ago" -Iseconds)
   while IFS='|' read -r env date; do
     if [[ "$date" < "$cutoff" ]]; then
       echo "DELETE: $env (last: $date)"
     else
       echo "KEEP:   $env (last: $date)"
     fi
   done < /tmp/latest_preview_deployments.txt
   ```

5. **Delete old preview environments:**
   ```bash
   cutoff=$(date -d "3 days ago" -Iseconds)
   count=0
   failed=0

   while read env; do
     encoded_env=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$env', safe=''))")
     if gh api -X DELETE "repos/:owner/:repo/environments/$encoded_env" --silent 2>/dev/null; then
       ((count++))
       if [ $((count % 50)) -eq 0 ]; then
         echo "Deleted $count environments..."
       fi
     else
       ((failed++))
     fi
   done < /tmp/preview_envs.txt

   echo ""
   echo "=== Summary ==="
   echo "Deleted: $count"
   echo "Failed:  $failed"
   ```

6. **Verify cleanup:**
   ```bash
   gh api repos/:owner/:repo/environments --paginate -q '.environments[] | .name' 2>/dev/null | grep -i preview | wc -l
   ```

7. **Show remaining environments:**
   ```bash
   gh api repos/:owner/:repo/environments --paginate -q '.environments[] | .name' 2>/dev/null
   ```

8. **Display final summary:**
   ```
   ## Cleanup Complete

   | Item | Count |
   |------|-------|
   | Deleted preview environments | X |
   | Failed | Y |

   ## Remaining Environments
   [List remaining production and active preview environments]
   ```

## Notes:
- This command only deletes GitHub Environments, not the deployment records
- Production environments (production, web/production, docs/production, npm) are NOT affected
- Preview environments with recent activity (within 3 days) are preserved
- The deletion process may take several minutes for large numbers of environments
