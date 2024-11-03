import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import { nodePolyfills } from "vite-plugin-node-polyfills";
import mkcert from "vite-plugin-mkcert";

export default defineConfig({
  plugins: [
    wasm(),
    nodePolyfills(),
    mkcert(),
  ],
  server: {
      https: true,
      cors: { origin: "*" },
  },
  base: '/',
  build: {
      commonjsOptions: {
          transformMixedEsModules: true,
      },
      sourcemap: false,  // Disable source maps
  }
});