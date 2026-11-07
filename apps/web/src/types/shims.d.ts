// Declaraciones mínimas para compilar sin @types/react instalado en este entorno.
// Al instalar @types/react (ver package.json raíz) este archivo puede eliminarse.
declare module 'react' {
  export type ReactNode = any;
  export type FormEvent = any;
  export type ChangeEvent<T = any> = { target: T & { value: string; checked?: boolean; files?: any } };
  export function useState<T>(initial: T | (() => T)): [T, (v: T | ((p: T) => T)) => void];
  export function useEffect(fn: () => void | (() => void), deps?: any[]): void;
  export function useRef<T = any>(initial: T | null): { current: T | null };
  export function useMemo<T>(fn: () => T, deps: any[]): T;
  export const StrictMode: any;
  const React: any;
  export default React;
}
declare module 'react-dom/client' { export function createRoot(el: Element): { render(node: any): void }; }
declare module 'react-dom/server' { export function renderToStaticMarkup(node: any): string; }
declare namespace JSX {
  interface IntrinsicElements { [tag: string]: any; }
  interface Element {}
}
