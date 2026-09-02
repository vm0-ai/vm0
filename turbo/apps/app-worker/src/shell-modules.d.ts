declare module "*.html" {
  const content: string;
  export default content;
}

declare module "*.txt" {
  const content: string;
  export default content;
}

declare module "*.bin" {
  const content: ArrayBuffer;
  export default content;
}
