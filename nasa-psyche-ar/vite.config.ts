/** Vite config: React, wasm-pack for Rust/WASM, base path for deployment. */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasmPack from 'vite-plugin-wasm-pack'

export default defineConfig({
  plugins: [
    react(),
    wasmPack('./rust_engine')
  ],
  base: '/psyche-ar-game/',
})
