import * as userSchema from "./schema/user";
import * as deviceCodesSchema from "./schema/device-codes";
import * as cliTokensSchema from "./schema/cli-tokens";
import * as apiKeySchema from "./schema/api-key";
import * as agentConfigSchema from "./schema/agent-config";
import * as agentRuntimeSchema from "./schema/agent-runtime";
import * as agentRuntimeEventSchema from "./schema/agent-runtime-event";

export const schema = {
  ...userSchema,
  ...deviceCodesSchema,
  ...cliTokensSchema,
  ...apiKeySchema,
  ...agentConfigSchema,
  ...agentRuntimeSchema,
  ...agentRuntimeEventSchema,
};
