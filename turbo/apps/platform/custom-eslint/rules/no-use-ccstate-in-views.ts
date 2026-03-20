/**
 * ESLint rule: no-use-ccstate-in-views
 *
 * Disallows useCCState() calls in views/ files.
 * Signals should only be declared in signals/ files, not inline in components.
 *
 * Good: const [value, setValue] = useState("") // React local state
 * Good: const value = useGet(someSignal$)      // consume signal from signals/
 * Bad:  const input$ = useCCState("")           // declaring signal in a view
 */

import { ESLintUtils } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/anthropics/vm0/blob/main/docs/eslint/${name}.md`,
);

type MessageIds = "noUseCCStateInViews";

export default createRule<[], MessageIds>({
  name: "no-use-ccstate-in-views",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow useCCState() in views/ — signals must be declared in signals/ files",
    },
    schema: [],
    messages: {
      noUseCCStateInViews:
        "useCCState() is not allowed in views/. For shared state, declare state()/computed()/command() in signals/ and consume with useGet()/useSet(). For component-local state, use React useState().",
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
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "useCCState"
        ) {
          context.report({
            node,
            messageId: "noUseCCStateInViews",
          });
        }
      },
    };
  },
});
