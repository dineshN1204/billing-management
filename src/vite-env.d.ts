/**
 * Type surface for the module vite-plugin-pwa resolves at build time.
 *
 * `virtual:pwa-register` has no file on disk, so TypeScript needs this
 * declaration to resolve the dynamic import in src/lib/pwa.ts. The shape matches
 * what vite-plugin-pwa's registerSW actually returns.
 */
declare module 'virtual:pwa-register' {
  export interface RegisterSWOptions {
    immediate?: boolean
    onNeedRefresh?: () => void
    onOfflineReady?: () => void
    onRegisteredSW?: (swUrl: string, registration: ServiceWorkerRegistration | undefined) => void
    onRegisterError?: (error: unknown) => void
  }

  export function registerSW(options?: RegisterSWOptions): {
    updateServiceWorker: (reloadPage?: boolean) => Promise<void>
  }
}