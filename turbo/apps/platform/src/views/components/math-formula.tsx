import { useLoadable } from "ccstate-react";
import type { Nodes, Root } from "hast";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { ReactNode } from "react";
import rehypeRaw from "rehype-raw";
import { unified } from "unified";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

import type { MarkdownMath } from "../../lib/markdown/math.ts";
import {
  katexBrowserRuntime$,
  type KatexBrowserRuntime,
} from "../../signals/math-formula.ts";

const mathMlProcessor = unified().use(rehypeRaw);
const KATEX_ERROR_COLOR = "okou-katex-error";

function hasKatexErrorNode(node: Nodes): boolean {
  if (
    node.type === "element" &&
    ((node.tagName === "mstyle" &&
      node.properties.mathcolor === KATEX_ERROR_COLOR) ||
      (node.tagName === "span" &&
        Array.isArray(node.properties.className) &&
        node.properties.className.includes("katex-error")))
  ) {
    return true;
  }
  return (
    (node.type === "element" || node.type === "root") &&
    node.children.some(hasKatexErrorNode)
  );
}

function renderMath(
  runtime: KatexBrowserRuntime,
  source: string,
  displayMode: boolean,
): ReactNode | undefined {
  const markup = runtime.renderToString(source, {
    displayMode,
    errorColor: KATEX_ERROR_COLOR,
    maxExpand: 1000,
    maxSize: 100,
    output: "mathml",
    throwOnError: false,
    trust: false,
  });
  const tree: Root = {
    type: "root",
    children: [{ type: "raw", value: markup }],
  };
  const processed = mathMlProcessor.runSync(tree, source);
  if (hasKatexErrorNode(processed)) {
    return undefined;
  }
  return toJsxRuntime(processed, {
    Fragment,
    jsx,
    jsxs,
    passKeys: true,
  });
}

function MathFrame({
  formula,
  rendered,
  status,
}: {
  readonly formula: MarkdownMath;
  readonly rendered?: ReactNode;
  readonly status: string;
}) {
  const Tag = formula.displayMode ? "div" : "span";
  const className = formula.displayMode
    ? "my-[14px] max-w-full overflow-x-auto overflow-y-hidden py-0.5 text-center whitespace-pre-wrap"
    : "whitespace-pre-wrap";
  return (
    <Tag className={className} data-math-status={status}>
      {rendered ?? formula.raw}
    </Tag>
  );
}

function RenderableMath({
  formula,
  source,
}: {
  readonly formula: MarkdownMath;
  readonly source: string;
}) {
  const runtime = useLoadable(katexBrowserRuntime$);
  const rendered =
    runtime.state === "hasData"
      ? renderMath(runtime.data, source, formula.displayMode)
      : undefined;
  const status =
    runtime.state === "hasData"
      ? rendered
        ? "rendered"
        : "hasError"
      : runtime.state;
  return <MathFrame formula={formula} status={status} rendered={rendered} />;
}

export function MathFormulaView({
  formula,
}: {
  readonly formula: MarkdownMath;
}) {
  return formula.source === null ? (
    <MathFrame formula={formula} status="source" />
  ) : (
    <RenderableMath formula={formula} source={formula.source} />
  );
}
