# Review: refactor: standardize webhook endpoint path and API configuration naming

**Commit:** 0caed8ad0c2e130fe4a35fb949fb5a82f459d02d
**Author:** Lan Chenyu
**Date:** Sat Nov 22 00:15:45 2025 +0800

## Summary

Standardized API configuration naming and webhook endpoint path structure across the codebase:

- Moved webhook endpoint from /api/webhooks/agent-events to /api/webhooks/agent/events (hierarchical structure)
- Renamed environment variables: VM0_WEBHOOK_URL → VM0_API_URL and VM0_WEBHOOK_TOKEN → VM0_API_TOKEN
- Updated bash script (run-agent-script.ts) to construct full webhook URL internally
- Updated E2BService to use new webhook path and environment variables
- Updated event-handler to reference new webhook path
- Fixed import paths throughout codebase after directory restructure
- Updated documentation for new webhook path and env vars

## Code Smell Analysis

### ✅ Good Practices

- Excellent API structure improvement - hierarchical /api/webhooks/agent/events is more RESTful than agent-events
- Clear semantic improvement in env var naming (VM0*API*_ is more descriptive than VM0*WEBHOOK*_)
- Centralized webhook URL construction in run-agent-script reduces duplication
- Comprehensive updates across all affected files (services, tests, documentation)
- Proper directory restructuring maintains clean project organization
- Documentation updated to reflect changes

### ⚠️ Issues Found

- **Bad Smell #11 (Hardcoded URLs and Configuration)** - Verify that no hardcoded webhook URLs remain in the codebase after this refactoring
- **Bad Smell #4 (Interface Changes)** - This is a significant breaking change to public API (webhook endpoint path and env var names)

### 💡 Recommendations

- Verify all client code that calls the webhook endpoint has been updated to use new path
- Add migration guide or deprecation warning if external systems consume this API
- Check if any documentation outside the codebase (README, setup guides, etc.) needs updating
- Consider adding API versioning if webhooks change frequently (e.g., /api/v1/webhooks/agent/events)
- Ensure all environment variable changes are documented in .env.example and deployment documentation

## Breaking Changes

- **API Endpoint**: Webhook moved from /api/webhooks/agent-events to /api/webhooks/agent/events
- **Environment Variables**:
  - VM0_WEBHOOK_URL → VM0_API_URL (also changed from full URL to base URL)
  - VM0_WEBHOOK_TOKEN → VM0_API_TOKEN
- **Webhook URL Construction**: Moved from sandbox env vars to run-agent-script (script now constructs webhook URL)
- **Directory Structure**: Webhook handler moved to /app/api/webhooks/agent/events/ (nested structure)
- **Import Paths**: All references to webhook handler require updated import paths with additional directory level
- **External Integrations**: Any external systems calling the webhook endpoint must update to new path
- **Configuration**: Deployment configurations must use new environment variable names
