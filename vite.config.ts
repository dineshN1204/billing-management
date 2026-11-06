import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * PWA configuration.
 *
 * The one rule that governs everything below: **no authenticated request is ever
 * cached.** This app holds invoices, customer GSTINs, material balances and
 * payment records. Caching any of that in a Cache Storage bucket readable by the
 * service worker would put private business data on a shared device's disk with
 * no expiry, and would let a later user of that device read it after sign-out.
 *
 * That is why `runtimeCaching` below is deliberately absent. Without it Workbox
 * caches nothing at runtime: it only serves the precached application shell. API
 * traffic goes straight to the network every time, so a challan recorded on a
 * phone is read from the same single source of truth as the desktop.
 *
 * Consequences, stated plainly because they are the honest trade-off:
 *  - The app opens and its navigation works with no connection.
 *  - Every screen that reads or writes business data needs to be online.
 *  - Nothing is ever written while offline, so a challan cannot be recorded
 *    twice by a retry once the connection returns.
 */
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Do not swap the running app for a new one silently. A worker that
      // calls skipWaiting() on its own can replace the code under a form the
      // user is halfway through filling in. Instead the new worker waits, and
      // the user is offered the update.
      registerType: 'prompt',
      // Registration is handled in src/lib/pwa.ts so the UI can react to it.
      injectRegister: null,
      includeAssets: ['favicon.ico', 'icons/apple-touch-icon.png'],
      manifest: {
        id: '/',
        name: 'Kallazhagar Industries · Billbook',
        short_name: 'Billbook',
        description:
          'Billing, delivery challans and material tracking for a CNC and job-work manufacturing unit.',
        lang: 'en-IN',
        dir: 'ltr',
        start_url: '/dc-dashboard',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        // Matches the sidebar colour in style.css and the theme-color meta tag.
        theme_color: '#182b33',
        background_color: '#f6f7f5',
        categories: ['business', 'finance', 'productivity'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The application shell only: hashed build output plus the icons.
        // No source maps, no markdown, no anything the browser never requests.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        // The pdfmake and virtual-font chunks are the largest artefacts in the build
        // (~1.9 MB together) and are only needed when a PDF is generated.
        // Excluding them keeps the install light on a phone; the browser Print
        // dialog, which needs no download, still produces a PDF offline.
        globIgnores: ['**/*.map', '**/node_modules/**', '**/pdf-engine*'],
        // Every unknown path is a client-side route, so a deep link opened
        // directly or after a refresh is answered with the shell.
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/icons\//],
        // Workbox's own cleanup, so a renamed precache file is not kept forever.
        cleanupOutdatedCaches: true,
        // Without clientsClaim the new worker activates but never takes control
        // of the page that is already open, so accept-update reload never fires
        // until the user manually refreshes. With prompt mode this is safe: the
        // swap only happens after the user tapped "Update now" and skipWaiting.
        clientsClaim: true,
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      devOptions: {
        // Off by default: a service worker in front of the dev server serves
        // stale bundles and makes every change look like it did not take.
        enabled: false,
      },
    }),
  ],
  build: {
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        /**
         * Separate the libraries that never change from the code that changes
         * with every commit.
         *
         * Without this, a one-line change to any page invalidates a single
         * ~700 kB bundle, so an employee on a phone re-downloads all of it - and
         * the service worker has to re-precache it - for a change that touched
         * none of it. Splitting the vendors means those bytes are served from
         * cache after the first visit, which is the difference between an update
         * landing instantly and an update costing half a megabyte of mobile data.
         */
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          // The PDF engine and its virtual font file. Named so the precache
          // exclusion below can match it: these two are ~1.9 MB together and are
          // only needed when a PDF is generated, not to open the app. The
          // browser's own Print dialog still produces a PDF with no download.
          if (/[\\/](pdfmake|pdfkit|vfs_fonts)[\\/]/.test(id)) return 'pdf-engine'
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom)[\\/]/.test(id)) return 'vendor-react'
          if (id.includes('@neondatabase')) return 'vendor-neon'
          if (/[\\/]node_modules[\\/]zod[\\/]/.test(id)) return 'vendor-zod'
          if (id.includes('lucide-react')) return 'vendor-icons'
          if (id.includes('decimal.js')) return 'vendor-decimal'
          return 'vendor'
        },
      },
    },
  },
})