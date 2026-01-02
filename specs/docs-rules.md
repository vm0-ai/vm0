# Integration Doc Rules

These rules defines the structure for documenting SaaS integrations in `turbo/apps/docs/content/docs/integration/`.
File Location `turbo/apps/docs/content/docs/integration/{skill-name}.mdx`
1. each integration should 和 vm0-ai/vm0-skills 下的对应 skill 描述一致
2. 每个 integration 文档的结构，参考后文 "Integration 文档结构" 这一部分的描述

## Adding to Navigation

Add the new file to `turbo/apps/docs/content/docs/integration/meta.json`, 并确保是按照名称排序:

```json
{
  "title": "Integration",
  "pages": [
    "existing-skill",
    "{new-skill-name}"
  ]
}
```

# Integration 文档结构

* 标题是 SaaS 服务名
* 副标题简单介绍该 SaaS 服务解决的最主要问题
* 第一段以这个 SaaS 服务名开头（要有外链），简单介绍这个 SaaS 服务

开头类似于

```mdx
---
title: {SaaS Name}
description: {Brief description of what the SaaS does}
---

[{SaaS Name}]({official-website-url}) is {one sentence description of the SaaS}.
```

## Required Environment
* 这一节用一个表格列出对应 vm0-ai/vm0-skills/<SAAS_NAME>/SKILL.md 中开头部分所编写的 vm0_secrets 和 vm0_vars
* 表格有三列，第一列为 Name，内容是环境变量的名称。第二列是 Type，有 secret 和 var 两种。第三列是 Description，介绍这个环境变量的作用，如果能从 SKILL.md 中获取到访问哪个地址来生成这个 Token 的话，就放个链接，类似于 [XXX Dashboard](https://...)

整体类似于下面的表格:

| Name                  | Type   | Description                                           |
| --------------------- | ------ | ----------------------------------------------------- |
| `CHATWOOT_API_TOKEN`  | secret | API access token from [Chatwoot Profile Settings](https://...)       |
| `CHATWOOT_ACCOUNT_ID` | var    | Account ID from the URL (e.g., `/app/accounts/1/...`) |
| `CHATWOOT_BASE_URL`   | var    | Base URL (e.g., `https://app.chatwoot.com`)           |

## Configuration
* 这一节列出一个 vm0.yaml 的例子，注意高亮对应的 skill 引用

整体类似于下面的代码块:

```yaml title="vm0.yaml"
version: "1.0"

agents:
  my-agent:
    provider: claude-code
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/apify # [!code highlight]
```

## Run

* 这一节列出运行时如何传递参数，注意高亮对应的 secrets / vars 传递
* 如果要传递多个 secrets / vars，需要在一行中进行高亮，否则 code block 和 highlight 注释会冲突
* 注意这里 run 参数应该和上面 required environment 保持一致

整体类似于下面的代码块:

```bash
vm0 run my-agent "list open conversations" \
  --secrets CHATWOOT_API_TOKEN=xxx --vars CHATWOOT_ACCOUNT_ID=xxx --vars CHATWOOT_BASE_URL=xxx # [!code highlight]
```

## Example Instructions

* 这里列出 2 个 AGENTS.md 的例子
* 例子中提一下要 use 这个 SaaS 来实现一个 workflow

整体类似于下面的代码块

```markdown title="AGENTS.md"
# Support Agent

You use Chatwoot to manage customer support conversations.

## Workflow

1. List open conversations
2. Read conversation messages
3. Send appropriate replies
4. Update conversation status

## Guidelines

- Use private notes for internal communication
- Assign conversations to appropriate agents
```

```markdown title="AGENTS.md"
# Contact Manager Agent

You use Chatwoot to manage customer contacts.

## Workflow

1. Search for existing contacts
2. Create new contacts if needed
3. Update contact information
4. Link contacts to conversations

## Contact Fields

- name, email, phone_number
- identifier (external system ID)
- custom_attributes
```
