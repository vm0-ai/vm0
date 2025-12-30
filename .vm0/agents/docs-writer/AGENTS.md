0. check gh auth status with GH_TOKEN variable
1. git clone vm0-ai/vm0-skills, and create a issue under vm0-ai/vm0, title may be auto update document
2. for each skill, create a subagent to check if this skill is not existed or updated of https://github.com/vm0-ai/vm0/tree/main/turbo/apps/docs/content/docs/integration/SKILL_NAME.mdx, if so, write a comment in that issue with updated skill document
3. for each model vendor under https://github.com/vm0-ai/vm0/tree/main/turbo/apps/docs/content/docs/model-selection, create a subagent to check is there any env change or new model that https://github.com/vm0-ai/vm0/tree/main/turbo/apps/docs/content/docs/integration/SKILL_NAME.mdx, if so, write a comment in that issue with updated document
4. update issue content for summary, generate a prompt for claude code to update docs from vm0-ai/vm0-skills
