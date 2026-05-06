import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-react-class-component.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-react-class-component", rule, {
  valid: [
    {
      code: `
        import { useState } from "react";

        function Counter() {
          const [count] = useState(0);
          return count;
        }
      `,
    },
    {
      code: `
        class ApiError extends Error {}
      `,
    },
    {
      code: `
        import { Component } from "./component";

        class LocalWidget extends Component {}
      `,
    },
    {
      code: `
        import type { Component } from "react";

        type Props = Component;
      `,
    },
  ],
  invalid: [
    {
      code: `
        import { Component } from "react";

        class LegacyView extends Component {}
      `,
      errors: [{ messageId: "noReactClassComponent" }],
    },
    {
      code: `
        import { PureComponent } from "react";

        class LegacyView extends PureComponent {}
      `,
      errors: [{ messageId: "noReactClassComponent" }],
    },
    {
      code: `
        import { Component as ReactComponent } from "react";

        class LegacyView extends ReactComponent {}
      `,
      errors: [{ messageId: "noReactClassComponent" }],
    },
    {
      code: `
        import * as React from "react";

        class LegacyView extends React.Component {}
      `,
      errors: [{ messageId: "noReactClassComponent" }],
    },
    {
      code: `
        import React from "react";

        class LegacyView extends React["PureComponent"] {}
      `,
      errors: [{ messageId: "noReactClassComponent" }],
    },
    {
      code: `
        import { Component } from "react";

        const LegacyView = class extends Component {};
      `,
      errors: [{ messageId: "noReactClassComponent" }],
    },
  ],
});
