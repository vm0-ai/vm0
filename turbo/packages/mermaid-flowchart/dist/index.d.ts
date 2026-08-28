export interface MermaidFlowchartThemeVariables {
  readonly fontSize?: string;
}

export interface MermaidFlowchartOptions {
  readonly nodeSpacing?: number;
  readonly rankSpacing?: number;
  readonly padding?: number;
}

export interface MermaidFlowchartConfig {
  readonly startOnLoad?: boolean;
  readonly securityLevel?: "strict";
  readonly suppressErrorRendering?: boolean;
  readonly theme?: "redux" | "redux-dark";
  readonly fontFamily?: string;
  readonly themeVariables?: MermaidFlowchartThemeVariables;
  readonly flowchart?: MermaidFlowchartOptions;
}

export interface MermaidParseOptions {
  readonly suppressErrors?: boolean;
}

export interface MermaidParseResult {
  readonly diagramType: string;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface MermaidRenderResult {
  readonly svg: string;
  readonly bindFunctions?: (element: Element) => void;
  readonly diagramType?: string;
}

export interface MermaidFlowchartApi {
  initialize(config: MermaidFlowchartConfig): void;
  parse(
    text: string,
    options?: MermaidParseOptions,
  ): Promise<MermaidParseResult | false>;
  render(id: string, text: string): Promise<MermaidRenderResult>;
}

declare const mermaid: MermaidFlowchartApi;

export default mermaid;
