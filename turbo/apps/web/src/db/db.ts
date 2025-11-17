import * as userSchema from "./schema/user";
import * as deviceCodesSchema from "./schema/device-codes";
import * as cliTokensSchema from "./schema/cli-tokens";

export const schema = {
  ...userSchema,
  ...deviceCodesSchema,
  ...cliTokensSchema,
};
