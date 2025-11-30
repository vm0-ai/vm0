import * as userSchema from "./schema/user";
import * as deviceCodesSchema from "./schema/device-codes";
import * as cliTokensSchema from "./schema/cli-tokens";
import * as agentConfigSchema from "./schema/agent-config";
import * as agentRunSchema from "./schema/agent-run";
import * as agentRunEventSchema from "./schema/agent-run-event";
import * as conversationSchema from "./schema/conversation";
import * as checkpointSchema from "./schema/checkpoint";
import * as agentSessionSchema from "./schema/agent-session";
import * as storageSchema from "./schema/storage";
import * as blobSchema from "./schema/blob";

export const schema = {
  ...userSchema,
  ...deviceCodesSchema,
  ...cliTokensSchema,
  ...agentConfigSchema,
  ...agentRunSchema,
  ...agentRunEventSchema,
  ...conversationSchema,
  ...checkpointSchema,
  ...agentSessionSchema,
  ...storageSchema,
  ...blobSchema,
};
