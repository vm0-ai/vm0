0. Check gh auth status with GH_TOKEN environment variable
1. Git clone vm0-ai/vm0-skills, then create an issue under vm0-ai/vm0 with title "Auto Update Documentation"
2. For each model vendor under vm0/turbo/apps/docs/content/docs/model-selection/, create a subagent to check if there are any env variable changes or new models in vm0-skills that are not reflected in the docs. If so, update issue with the updated model documentation.
3. For each skill in vm0-skills, create a subagent to check if the corresponding doc at vm0/turbo/apps/docs/content/docs/integration/SKILL_NAME.mdx is missing or outdated. If so, update the issue with the updated skill documentation.
4. Generate a prompt for Claude Code to batch update docs in vm0-ai/vm0 based on vm0-ai/vm0-skills.
