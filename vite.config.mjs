import * as child from "child_process";
import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import { nodePolyfills } from "vite-plugin-node-polyfills";
import mkcert from "vite-plugin-mkcert";

const commitHash = child
    .execSync("git rev-parse --short HEAD")
    .toString()
    .trim();

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
        target: 'esnext', // Ensures support for modern JavaScript features
        commonjsOptions: {
            transformMixedEsModules: true,
        },
        sourcemap: false,  // Disable source maps
    },
    css: {
        preprocessorOptions: {
            scss: {
                api: "modern-compiler",
            },
        },
    },
    define: {
        __APP_VERSION__: JSON.stringify(process.env.npm_package_version),
        __GIT_COMMIT__: JSON.stringify(commitHash),
    },
});