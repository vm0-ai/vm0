# VM0 Agent Creator Wizard

This skill guides users through creating a complete VM0 agent configuration. The wizard produces two files: `vm0.yaml` (configuration) and `AGENTS.md` (agent instructions).

## Workflow Overview

The wizard follows these phases:
1. Language preference selection
2. LLM backend selection
3. Workflow description gathering
4. Skills recommendation and selection
5. Agent instructions design (AGENTS.md)
6. Skills completeness verification
7. Configuration generation (vm0.yaml)
8. Environment setup (.env)
9. Testing guidance

---

## Phase 1: Language Selection

**Start the conversation with this multilingual greeting:**

```
Welcome to the VM0 Agent Creator!

Please select your preferred language for this workflow:
ワークフロー言語を選択してください：
Bitte wählen Sie Ihre Workflow-Sprache:
Por favor seleccione su idioma preferido:

1. English (Default)
2. 日本語
3. Deutsch
4. Español

Enter your choice (1-4) or type your preferred language:
```

After selection, continue the entire workflow in the user's chosen language.

---

## Phase 2: LLM Backend Selection

Ask the user which LLM backend they want to use:

```
Which LLM backend would you like to use for your agent?

1. Claude (OAuth Token) - Recommended for Claude Code users
   Run `claude setup-token` to get your token

2. OpenRouter - Access multiple models via OpenRouter
   Docs: https://openrouter.ai/docs/guides/claude-code-integration

3. DeepSeek - Cost-effective alternative
   Docs: https://api-docs.deepseek.com/guides/anthropic_api

4. MiniMax - MiniMax-M2.1 model
   Docs: https://platform.minimax.io/docs/guides/text-ai-coding-tools

5. Kimi - Moonshot AI's Kimi-K2 model
   Docs: https://platform.moonshot.ai/docs/guide/agent-support

Enter your choice (1-5):
```

### Environment Variables by Backend

**1. Claude (OAuth Token)**
```yaml
environment:
  CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

**2. OpenRouter**
```yaml
environment:
  ANTHROPIC_BASE_URL: "https://openrouter.ai/api"
  ANTHROPIC_AUTH_TOKEN: ${{ secrets.OPENROUTER_API_KEY }}
  ANTHROPIC_API_KEY: ""
```

**3. DeepSeek**
```yaml
environment:
  ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic"
  ANTHROPIC_AUTH_TOKEN: ${{ secrets.DEEPSEEK_API_KEY }}
  API_TIMEOUT_MS: "600000"
  ANTHROPIC_MODEL: "deepseek-chat"
  ANTHROPIC_SMALL_FAST_MODEL: "deepseek-chat"
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
```

**4. MiniMax**
```yaml
environment:
  ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic"
  ANTHROPIC_AUTH_TOKEN: ${{ secrets.MINIMAX_API_KEY }}
  API_TIMEOUT_MS: "3000000"
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
  ANTHROPIC_MODEL: "MiniMax-M2.1"
  ANTHROPIC_SMALL_FAST_MODEL: "MiniMax-M2.1"
  ANTHROPIC_DEFAULT_SONNET_MODEL: "MiniMax-M2.1"
  ANTHROPIC_DEFAULT_OPUS_MODEL: "MiniMax-M2.1"
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "MiniMax-M2.1"
```

**5. Kimi**
```yaml
environment:
  ANTHROPIC_BASE_URL: "https://api.moonshot.ai/anthropic"
  ANTHROPIC_AUTH_TOKEN: ${{ secrets.MOONSHOT_API_KEY }}
  ANTHROPIC_MODEL: "kimi-k2-thinking-turbo"
  ANTHROPIC_DEFAULT_OPUS_MODEL: "kimi-k2-thinking-turbo"
  ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-k2-thinking-turbo"
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "kimi-k2-thinking-turbo"
  CLAUDE_CODE_SUBAGENT_MODEL: "kimi-k2-thinking-turbo"
```

Store the user's choice - these environment variables will be merged into the final vm0.yaml.

---

## Phase 3: Workflow Description

Ask the user to describe their agent workflow in their own words. Prompt them with:

**English Example:**
> Please describe the workflow you want your agent to perform. For example:
> - "Fetch news from Hacker News, summarize them, generate audio narration, upload to Notion, and send email notifications"
> - "Monitor GitHub issues, analyze sentiment, and post summaries to Slack"
> - "Scrape product prices, compare with historical data, and alert via Discord"

Encourage the user to be specific about:
- **Input sources**: Where does data come from?
- **Processing steps**: What transformations or analysis?
- **Output destinations**: Where should results go?
- **Triggers/Schedule**: How often or when should it run?

---

## Phase 4: Skills Recommendation

After understanding the workflow, **always fetch the latest skills** from the vm0-ai/vm0-skills repository.

### How to Find Skills

1. **Browse the repository**: Visit https://github.com/vm0-ai/vm0-skills to see all available skills
2. **Check skill details**: Each skill directory contains a README with:
   - Required environment variables/secrets
   - Usage examples
   - API documentation

### Recommendation Process

1. Match user workflow requirements to available skills
2. Present recommendations with brief explanations:
   ```
   Based on your workflow, I recommend these skills:

   1. **hackernews** - Fetch articles from Hacker News
   2. **elevenlabs** - Convert text summaries to audio
   3. **notion** - Store and organize content
   4. **zeptomail** - Send email notifications

   Would you like to:
   - Add any of these skills?
   - Explore other third-party services?
   - Use Claude's built-in web search instead of a dedicated scraper?
   ```

3. Remind the user:
   - Claude Code has built-in **web search** capability for simple information retrieval
   - For more sophisticated scraping needs, recommend `firecrawl`, `apify`, or `scrapeninja`

---

## Phase 5: Agent Instructions Design (AGENTS.md)

Create the `AGENTS.md` file with this structure:

```markdown
# [Agent Name]

[Brief description of what the agent does]

1. [Step name]:
- Detail 1
- Detail 2

2. [Step name]:
- Detail 1
- Detail 2

[... additional steps ...]

## Guidelines
- [Important constraint or rule]
- [Best practice]
```

After writing the initial draft, ask the user:

```
I've created the initial workflow design in AGENTS.md. Please review it and let me know:

1. Are there any steps you'd like to add, remove, or modify?
2. Are there any additional constraints or guidelines?
3. Would you like to edit the file directly? Just let me know when you're done.
```

---

## Phase 6: Skills Completeness Check

Review the final AGENTS.md against the recommended skills:

1. **Verify coverage**: Can the selected skills fulfill all workflow steps?
2. **Identify gaps**: Are there capabilities the agent needs but no skill provides?

If gaps exist:
- Suggest additional skills from vm0-ai/vm0-skills
- Recommend third-party SaaS services with APIs
- Document any required API tokens/secrets in AGENTS.md

Example gap analysis response:
```
Looking at your workflow, I noticed:

✅ Phase 1 (Data fetching) - Covered by `hackernews` skill
✅ Phase 2 (Summarization) - Claude Code built-in capability
⚠️ Phase 3 (Audio generation) - Needs `elevenlabs` skill
⚠️ Phase 4 (Storage) - Needs `notion` skill (requires NOTION_API_KEY)
❌ Phase 5 (Email) - Missing email capability

For email, I recommend:
- `zeptomail` - Transactional email (requires ZEPTOMAIL_TOKEN)
- `instantly` - Email automation (requires INSTANTLY_API_KEY)

Which would you prefer?
```

---

## Phase 7: Configuration Generation (vm0.yaml)

Generate the `vm0.yaml` file based on the finalized workflow. **Merge the LLM backend environment variables from Phase 2 with skill-specific variables.**

```yaml
version: "1.0"

agents:
  [agent-name]:
    provider: claude-code
    instructions: AGENTS.md
    skills:
      - "https://github.com/vm0-ai/vm0-skills/tree/main/skill-name"
    environment:
      # LLM backend variables (from Phase 2 selection)
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      # Skill-specific variables
      SECRET_NAME: ${{ secrets.SECRET_NAME }}
      VARIABLE_NAME: ${{ vars.variableName }}
```

### Configuration Notes

1. **Provider**: Always `claude-code` for Claude Code agents
2. **Instructions**: Path to AGENTS.md file
3. **Skills**: Use full GitHub URLs to vm0-ai/vm0-skills
4. **Environment**: Merge LLM backend vars (Phase 2) + skill-specific vars
5. **Secrets**: Use `${{ secrets.KEY }}` syntax - stored in VM0 account
6. **Variables**: Use `${{ vars.key }}` syntax - passed at runtime

---

## Phase 8: Environment Setup

Before running the agent, set up the environment file with all required secrets and variables.

### Step 1: Update .gitignore

Add `.env` to `.gitignore` to prevent secrets from being committed:

```bash
echo ".env" >> .gitignore
```

### Step 2: Extract keys from vm0.yaml

Parse the generated vm0.yaml and extract all keys from:
- `${{ secrets.XXX }}` → add `XXX=` to .env
- `${{ vars.XXX }}` → add `XXX=` to .env

### Step 3: Create .env file

Create `.env` with all extracted keys (empty values):

```
KEY1=
KEY2=
KEY3=
```

### Step 4: Provide instructions for each key

For each key in the .env file, provide specific instructions on how to obtain it:

1. **LLM backend keys**: Refer to Phase 2 documentation links
2. **Skill keys**: Read the skill's README in https://github.com/vm0-ai/vm0-skills/tree/main/[skill-name] - each skill documents how to obtain its required API keys

### Step 5: Inform user

Tell the user to fill in all keys before running:

```
I've created .env with the following keys (extracted from vm0.yaml):

1. CLAUDE_CODE_OAUTH_TOKEN
   → Run: claude setup-token
   → Copy the token and paste it after the =

2. NOTION_API_KEY
   → Go to: https://www.notion.so/my-integrations
   → Click "New integration", copy the "Internal Integration Secret"

3. notionDatabaseId
   → Open your Notion database
   → Copy the ID from the URL: notion.so/xxx?v=yyy (xxx is the ID)

[... list each key from .env ...]

Once all keys are filled in, run:
  vm0 cook
```

---

## Phase 9: Testing Guidance

After the user has filled in all keys, provide testing instructions:

```
Your agent is ready! Here's how to run and test it:

## Full Run
vm0 cook

## Step-by-Step Testing (Recommended)
Test your workflow incrementally:

# Run only Phase 1
vm0 cook "Execute only Phase 1: [phase name]"

# Review the output, then continue
vm0 run continue [run-id] "Execute Phase 2"

# Or run multiple phases
vm0 cook "Execute Phases 1-3, then pause for review"

## Debugging Tips
- Check logs: vm0 logs [run-id]
- View run status: vm0 runs list
- Resume failed run: vm0 run resume [run-id]
```

---

## Few-shot Examples

Use these examples as reference when generating AGENTS.md and vm0.yaml files.

### Example 1: News Digest Agent

**User request**: "Fetch news, summarize, generate audio, deliver via email/Notion"

**AGENTS.md**:
```markdown
# News Digest Agent

Automatically curates and delivers daily news digests from tech sources.

## Workflow

### Phase 1: Gather News
Fetch top stories from Hacker News.

### Phase 2: Summarize Content
For each story:
1. Extract key points
2. Write a 2-3 sentence summary
3. Identify main topic/category

Compile into a structured digest format.

### Phase 3: Generate Audio
Use elevenlabs to convert the digest to audio narration.
Voice: Default or user-specified
Format: MP3

### Phase 4: Store in Notion
Create a new page in the target Notion database with:
- Title: "Daily Digest - [Date]"
- Content: Formatted summaries with source links
- Audio: Embed audio file if generated

### Phase 5: Send Notification
Use zeptomail to send email notification with:
- Subject: "Your Daily Tech Digest - [Date]"
- Body: Summary of top 3 stories with link to Notion page

## Guidelines
- Run daily at user-specified time
- Include source attribution for all content
- Handle API failures gracefully with retries
```

**vm0.yaml** (using Claude OAuth):
```yaml
version: "1.0"

agents:
  news-digest:
    provider: claude-code
    instructions: AGENTS.md
    skills:
      - "https://github.com/vm0-ai/vm0-skills/tree/main/hackernews"
      - "https://github.com/vm0-ai/vm0-skills/tree/main/elevenlabs"
      - "https://github.com/vm0-ai/vm0-skills/tree/main/notion"
      - "https://github.com/vm0-ai/vm0-skills/tree/main/zeptomail"
    environment:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      ELEVENLABS_API_KEY: ${{ secrets.ELEVENLABS_API_KEY }}
      NOTION_API_KEY: ${{ secrets.NOTION_API_KEY }}
      ZEPTOMAIL_TOKEN: ${{ secrets.ZEPTOMAIL_TOKEN }}
      NOTION_DATABASE_ID: ${{ vars.notionDatabaseId }}
      RECIPIENT_EMAIL: ${{ vars.recipientEmail }}
```

---

### Example 2: GitHub Issue Analyzer

**User request**: "Monitor GitHub issues, analyze sentiment, report to Slack"

**AGENTS.md**:
```markdown
# GitHub Issue Analyzer

Monitors repository issues and provides sentiment analysis reports.

1. Fetch Recent Issues, use github to retrieve:
- New issues from last 24 hours
- Updated issues with new comments
- Closed issues (for trend analysis)

2. Analyze Content, for each issue:
- Classify: bug, feature request, question, other
- Assess sentiment: positive, neutral, negative, urgent
- Extract key themes and common patterns

3. Generate Report, create summary with:
- Total issues by category
- Sentiment distribution
- Trending topics
- Issues requiring immediate attention

4. Notify Team, post to Slack channel with:
- Daily summary statistics
- Highlight urgent issues
- Link to detailed report

## Guidelines
- Flag issues with negative sentiment for priority review
- Track issue resolution trends over time
- Avoid duplicate notifications for same issues
```

**vm0.yaml** (using DeepSeek):
```yaml
version: "1.0"

agents:
  issue-analyzer:
    provider: claude-code
    instructions: AGENTS.md
    skills:
      - "https://github.com/vm0-ai/vm0-skills/tree/main/github"
      - "https://github.com/vm0-ai/vm0-skills/tree/main/slack-webhook"
    environment:
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic"
      ANTHROPIC_AUTH_TOKEN: ${{ secrets.DEEPSEEK_API_KEY }}
      API_TIMEOUT_MS: "600000"
      ANTHROPIC_MODEL: "deepseek-chat"
      ANTHROPIC_SMALL_FAST_MODEL: "deepseek-chat"
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
      REPO_OWNER: ${{ vars.repoOwner }}
      REPO_NAME: ${{ vars.repoName }}
```

---

### Example 3: Content Farm

**User request**: "Generate SEO-optimized blog posts from trending topics"

**AGENTS.md**:
```markdown
# Content Farm Agent

Generates high-quality, SEO-optimized blog articles from trending news.

1. Gather News from RSS feeds (Hacker News, TechCrunch, Wired, The Verge)

2. Select Topic:
- Most trending/engaging topic
- Good SEO potential
- Not recently covered

3. Create Outline:
- SEO-optimized title
- Introduction hook
- 3-5 main sections
- Conclusion with CTA

4. Write Article (1000-2000 words):
- Engaging, conversational tone
- Proper citations
- SEO keywords naturally integrated

5. Generate Image using fal.ai:
- Relevant to article topic
- 16:9 aspect ratio

6. Publish to Dev.to with tags (max 4)

## Guidelines
- Write in English unless specified
- Always cite sources
- Avoid clickbait titles
```

**vm0.yaml** (using OpenRouter):
```yaml
version: "1.0"

agents:
  content-farm:
    provider: claude-code
    instructions: AGENTS.md
    skills:
      - "https://github.com/vm0-ai/vm0-skills/tree/main/rss-fetch"
      - "https://github.com/vm0-ai/vm0-skills/tree/main/fal.ai"
      - "https://github.com/vm0-ai/vm0-skills/tree/main/devto-publish"
    environment:
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api"
      ANTHROPIC_AUTH_TOKEN: ${{ secrets.OPENROUTER_API_KEY }}
      ANTHROPIC_API_KEY: ""
      FAL_KEY: ${{ secrets.FAL_KEY }}
      DEVTO_API_KEY: ${{ secrets.DEVTO_API_KEY }}
```

---

### Example 4: Price Monitor

**User request**: "Track product prices and alert on changes"

**AGENTS.md**:
```markdown
# Price Monitor Agent

Monitors product prices and sends alerts when prices drop.

1. Load Product List from Notion database

2. Scrape Prices using firecrawl:
- Visit each product page
- Extract current price
- Get availability status

3. Compare with History:
- Retrieve previous price from Notion
- Calculate price change percentage

4. Update Database in Notion:
- Current price and timestamp
- Price change from last check

5. Send Alerts if price dropped > 10%:
- Discord notification with product name, old/new price, link

## Guidelines
- Run every 6 hours
- Respect rate limits on target sites
- Handle out-of-stock gracefully
```

**vm0.yaml** (using Kimi):
```yaml
version: "1.0"

agents:
  price-monitor:
    provider: claude-code
    instructions: AGENTS.md
    skills:
      - "https://github.com/vm0-ai/vm0-skills/tree/main/firecrawl"
      - "https://github.com/vm0-ai/vm0-skills/tree/main/notion"
      - "https://github.com/vm0-ai/vm0-skills/tree/main/discord-webhook"
    environment:
      ANTHROPIC_BASE_URL: "https://api.moonshot.ai/anthropic"
      ANTHROPIC_AUTH_TOKEN: ${{ secrets.MOONSHOT_API_KEY }}
      ANTHROPIC_MODEL: "kimi-k2-thinking-turbo"
      ANTHROPIC_DEFAULT_OPUS_MODEL: "kimi-k2-thinking-turbo"
      ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-k2-thinking-turbo"
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "kimi-k2-thinking-turbo"
      CLAUDE_CODE_SUBAGENT_MODEL: "kimi-k2-thinking-turbo"
      FIRECRAWL_API_KEY: ${{ secrets.FIRECRAWL_API_KEY }}
      NOTION_API_KEY: ${{ secrets.NOTION_API_KEY }}
      DISCORD_WEBHOOK_URL: ${{ secrets.DISCORD_WEBHOOK_URL }}
      NOTION_DATABASE_ID: ${{ vars.notionDatabaseId }}
```

---

### Example 5: Research Assistant

**User request**: "Deep research on topics with comprehensive reports"

**AGENTS.md**:
```markdown
# Research Assistant Agent

Conducts thorough research and produces comprehensive reports.

1. Initial Search using tavily:
- Primary topic query
- Related subtopics
- Recent news and developments

2. Deep Dive for each source:
- Extract key information
- Identify claims and evidence
- Note conflicting viewpoints

3. Synthesize findings:
- Executive summary
- Key findings (with citations)
- Different perspectives
- Gaps in available information

4. Generate Report:
- Clear headings
- Bullet points for quick scanning
- Inline citations
- Further reading section

5. Store in Notion:
- Title: "[Topic] Research Report - [Date]"
- Full formatted report
- Source links as references

## Guidelines
- Cite all claims with sources
- Note confidence levels
- Maintain neutral, objective tone
```

**vm0.yaml** (using MiniMax):
```yaml
version: "1.0"

agents:
  research-assistant:
    provider: claude-code
    instructions: AGENTS.md
    skills:
      - "https://github.com/vm0-ai/vm0-skills/tree/main/tavily"
      - "https://github.com/vm0-ai/vm0-skills/tree/main/notion"
    environment:
      ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic"
      ANTHROPIC_AUTH_TOKEN: ${{ secrets.MINIMAX_API_KEY }}
      API_TIMEOUT_MS: "3000000"
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
      ANTHROPIC_MODEL: "MiniMax-M2.1"
      ANTHROPIC_SMALL_FAST_MODEL: "MiniMax-M2.1"
      ANTHROPIC_DEFAULT_SONNET_MODEL: "MiniMax-M2.1"
      ANTHROPIC_DEFAULT_OPUS_MODEL: "MiniMax-M2.1"
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "MiniMax-M2.1"
      TAVILY_API_KEY: ${{ secrets.TAVILY_API_KEY }}
      NOTION_API_KEY: ${{ secrets.NOTION_API_KEY }}
      NOTION_PAGE_ID: ${{ vars.notionPageId }}
```

---

## Error Handling

If the user describes a workflow that cannot be automated:
- Explain which parts are problematic
- Suggest alternatives or manual steps
- Offer to create a partial automation

If required APIs are unavailable or complex:
- Suggest simpler alternatives
- Offer to document manual integration points
- Recommend SaaS services with good API support
