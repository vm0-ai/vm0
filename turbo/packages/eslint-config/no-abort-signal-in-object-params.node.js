import assert from "node:assert/strict";
import test from "node:test";

import { Linter } from "eslint";
import tseslint from "typescript-eslint";

import { noAbortSignalInObjectParams } from "./no-abort-signal-in-object-params.js";

const plugin = {
  rules: {
    "no-abort-signal-in-object-params": noAbortSignalInObjectParams,
  },
};

function lint(code, options) {
  const linter = new Linter();
  return linter.verify(code, [
    {
      languageOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        parser: tseslint.parser,
      },
      plugins: { okou: plugin },
      rules: {
        "okou/no-abort-signal-in-object-params": ["error", options ?? {}],
      },
    },
  ]);
}

test("allows a direct signal parameter", () => {
  assert.deepEqual(lint("function load(args, signal) { return signal; }"), []);
});

test("allows callbacks that return lifecycle signals", () => {
  assert.deepEqual(
    lint("function load(options) { return options.resetTimerSignal(); }"),
    [],
  );
});

test("reports signal member access on a parameter", () => {
  const messages = lint("function load(args) { return args.signal; }");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].messageId, "objectMember");
});

test("reports signal destructured from a parameter", () => {
  const messages = lint(
    "function load(args) { const { signal } = args; return signal; }",
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].messageId, "objectMember");
});

test("reports signal in a destructured function parameter", () => {
  const messages = lint("function View({ pageSignal }) { return pageSignal; }");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].messageId, "objectMember");
});

test("allows reviewed boundary functions", () => {
  assert.deepEqual(
    lint("function createApp({ signal }) { return signal; }", {
      allowedFunctions: ["createApp"],
    }),
    [],
  );
});

test("reports passing a typed signal-bearing object with its signal member", () => {
  const messages = lint(`
    type Runtime = { signal: AbortSignal; value: string };
    declare function runtime(): Runtime;
    declare function consume(input: { value: string }, signal: AbortSignal): void;
    function load(signal: AbortSignal) {
      const input: Runtime = runtime();
      consume(input, input.signal);
      return signal;
    }
  `);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].messageId, "objectAndSignalArgument");
});

test("reports Omit used to hide a signal member", () => {
  const messages = lint(`
    type Runtime = { signal: AbortSignal; value: string };
    function consume(input: Omit<Runtime, "signal">, signal: AbortSignal) {
      return [input, signal];
    }
  `);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].messageId, "signalOmit");
});
