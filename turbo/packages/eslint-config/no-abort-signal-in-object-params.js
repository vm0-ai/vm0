function isFunction(node) {
  return (
    node?.type === "FunctionDeclaration" ||
    node?.type === "FunctionExpression" ||
    node?.type === "ArrowFunctionExpression"
  );
}

function functionName(node) {
  if (!node) {
    return undefined;
  }
  if (node.type === "FunctionDeclaration") {
    return node.id?.name;
  }
  if (
    node.parent?.type === "VariableDeclarator" &&
    node.parent.id.type === "Identifier"
  ) {
    return node.parent.id.name;
  }
  if (
    node.parent?.type === "Property" &&
    node.parent.key.type === "Identifier"
  ) {
    return node.parent.key.name;
  }
  if (
    node.parent?.type === "MethodDefinition" &&
    node.parent.key.type === "Identifier"
  ) {
    return node.parent.key.name;
  }
  return undefined;
}

function enclosingFunction(node) {
  let current = node;
  while (current && !isFunction(current)) {
    current = current.parent;
  }
  return current;
}

function memberPropertyName(node) {
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  if (
    node.computed &&
    node.property.type === "Literal" &&
    typeof node.property.value === "string"
  ) {
    return node.property.value;
  }
  return undefined;
}

function patternPropertyName(node) {
  if (node.key.type === "Identifier") {
    return node.key.name;
  }
  if (node.key.type === "Literal" && typeof node.key.value === "string") {
    return node.key.value;
  }
  return undefined;
}

function isAbortSignalProperty(name) {
  if (name === "signal" || name === "abortSignal") {
    return true;
  }
  return (
    name?.endsWith("Signal") === true &&
    !/^(?:create|get|load|on|reset|resolve|set|waitFor)[A-Z]/u.test(name)
  );
}

function findVariable(scope, name) {
  let current = scope;
  while (current) {
    const variable = current.set.get(name);
    if (variable) {
      return variable;
    }
    current = current.upper;
  }
  return undefined;
}

function parameterDefinition(variable) {
  return variable?.defs.find((definition) => {
    return definition.type === "Parameter";
  });
}

function objectPatternProperties(pattern) {
  return pattern.properties.filter((property) => {
    return property.type === "Property";
  });
}

export const noAbortSignalInObjectParams = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require AbortSignal to be passed directly instead of inside object parameters",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowedFunctions: {
            type: "array",
            items: { type: "string" },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      objectMember:
        "Pass AbortSignal as a separate final parameter instead of the '{{property}}' member of '{{parameter}}'. React components should read their lifecycle signal directly.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const allowedFunctions = new Set(
      context.options[0]?.allowedFunctions ?? [],
    );
    const reportedParameters = new WeakSet();

    function isAllowed(node) {
      const name = functionName(node);
      return name !== undefined && allowedFunctions.has(name);
    }

    function report(node, parameterNode, parameter, property) {
      if (reportedParameters.has(parameterNode)) {
        return;
      }
      reportedParameters.add(parameterNode);
      context.report({
        node,
        messageId: "objectMember",
        data: { parameter, property },
      });
    }

    function checkObjectPattern(pattern, functionNode) {
      if (isAllowed(functionNode)) {
        return;
      }
      for (const property of objectPatternProperties(pattern)) {
        const propertyName = patternPropertyName(property);
        if (isAbortSignalProperty(propertyName)) {
          report(property, pattern, "object parameter", propertyName);
          return;
        }
      }
    }

    function checkFunction(node) {
      for (const parameter of node.params) {
        const unwrapped =
          parameter.type === "AssignmentPattern" ? parameter.left : parameter;
        if (unwrapped.type === "ObjectPattern") {
          checkObjectPattern(unwrapped, node);
        }
      }
    }

    return {
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
      MemberExpression(node) {
        const property = memberPropertyName(node);
        if (
          !isAbortSignalProperty(property) ||
          node.object.type !== "Identifier"
        ) {
          return;
        }
        const variable = findVariable(
          sourceCode.getScope(node),
          node.object.name,
        );
        const definition = parameterDefinition(variable);
        if (!definition) {
          return;
        }
        const owner = enclosingFunction(definition.name);
        if (isAllowed(owner)) {
          return;
        }
        report(node, definition.name, node.object.name, property);
      },
      VariableDeclarator(node) {
        if (
          node.id.type !== "ObjectPattern" ||
          node.init?.type !== "Identifier"
        ) {
          return;
        }
        const variable = findVariable(
          sourceCode.getScope(node),
          node.init.name,
        );
        const definition = parameterDefinition(variable);
        if (!definition) {
          return;
        }
        const owner = enclosingFunction(definition.name);
        if (isAllowed(owner)) {
          return;
        }
        for (const property of objectPatternProperties(node.id)) {
          const propertyName = patternPropertyName(property);
          if (isAbortSignalProperty(propertyName)) {
            report(property, definition.name, node.init.name, propertyName);
            return;
          }
        }
      },
    };
  },
};
