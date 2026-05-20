import type { ConnectorConfig } from "../connectors";

export const weread = {
  weread: {
    label: "WeRead",
    category: "docs-files-knowledge",
    tags: [
      "weread",
      "微信读书",
      "wechat reading",
      "books",
      "reading",
      "highlights",
      "notes",
      "bookshelf",
    ],
    environmentMapping: {
      WEREAD_TOKEN: "$secrets.WEREAD_TOKEN",
    },
    helpText:
      "Connect WeChat Reading (微信读书) to search books, browse your bookshelf, and read your notes, highlights, reviews, and reading statistics",
    authMethods: {
      "api-token": {
        label: "WeRead API Key",
        helpText:
          "1. Open the [WeRead Skill page](https://weread.qq.com/r/weread-skills)\n2. Scan the QR code with WeChat to sign in to your WeChat Reading account\n3. Copy the generated API key (it begins with `wrk-`)\n4. The key authorises every endpoint under `i.weread.qq.com` and is scoped to your own account data",
        secrets: {
          WEREAD_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "wrk-xxxxxxxxxxxxxxxx",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
