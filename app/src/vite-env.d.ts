/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

/** The commit the dashboard was built from (vite.config.ts); null outside a git checkout. */
declare const __APP_COMMIT__: string | null;

interface ImportMetaEnv {
  readonly VITE_AGENTDECK_API?: string;
}
