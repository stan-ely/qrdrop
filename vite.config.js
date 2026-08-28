import { defineConfig } from 'vite'

export default defineConfig({
  // Relative base so the built site works from any static host path
  // (GitHub Pages project sites, IPFS gateways, file://-adjacent hosting).
  base: './',
  build: {
    target: 'es2022',
    // No inlining: every asset stays a discrete file so it can carry an
    // integrity hash and be independently verified.
    assetsInlineLimit: 0,
  },
  server: {
    // Camera access and WebCrypto both require a secure context.
    // localhost counts as secure, so plain http is fine for dev.
    host: '127.0.0.1',
  },
})
