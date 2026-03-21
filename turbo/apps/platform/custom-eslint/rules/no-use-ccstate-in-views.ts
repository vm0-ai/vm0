/**
 * ESLint rule: no-use-ccstate-in-views
 *
 * Disallows importing from "ccstate-react/experimental" in views/ files.
 * The experimental module contains hooks like useCCState, useCommand, useCompute
 * that should not be used in view components.
 *
 * Good: const value = useGet(someSignal$)      // consume signal from signals/
 * Good: const [value, setValue] = useState("")  // React local state
 * Bad:  import { useCCState } from "ccstate-react/experimental"
 * Bad:  import { useCommand } from "ccstate-react/experimental"
 */

import { ESLintUtils } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/anthropics/vm0/blob/main/docs/eslint/${name}.md`,
);

type MessageIds = "noExperimentalImport";

export default createRule<[], MessageIds>({
  name: "no-use-ccstate-in-views",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow importing from ccstate-react/experimental in views/ — signals must be declared in signals/ files",
    },
    schema: [],
    messages: {
      noExperimentalImport:
        'Importing from "ccstate-react/experimental" is not allowed in views/. For shared state, declare state()/computed()/command() in signals/ and consume with useGet()/useSet(). For component-local state, use React useState().',
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = context.filename.replace(/\\/g, "/");

    const isInViews = /\/src\/views\//.test(filename);
    if (!isInViews) {
      return {};
    }

    return {
      ImportDeclaration(node) {
        if (node.source.value === "ccstate-react/experimental") {
          context.report({
            node,
            messageId: "noExperimentalImport",
          });
        }
      },
    };
  },
});
