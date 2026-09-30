/// <reference types="vite/client" />
declare module "*.json" {
  const value: { fixtures: unknown[] } & Record<string, unknown>;
  export default value;
}
