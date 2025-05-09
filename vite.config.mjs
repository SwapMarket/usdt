import * as child from "child_process";
import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import { nodePolyfills } from "vite-plugin-node-polyfills";
import mkcert from "vite-plugin-mkcert";
import vitePluginBundleObfuscator from 'vite-plugin-bundle-obfuscator';

const defaultObfuscatorConfig = {
  excludes: [],
  enable: true,
  log: true,
  autoExcludeNodeModules: false,
  // autoExcludeNodeModules: { enable: true, manualChunks: ['vue'] }
  threadPool: false,
  // threadPool: { enable: true, size: 4 }
  options: {
    compact: true,
    controlFlowFlattening: false,
    controlFlowFlatteningThreshold: 1,
    deadCodeInjection: false,
    debugProtection: false,
    debugProtectionInterval: 0,
    disableConsoleOutput: true,
    identifierNamesGenerator: 'hexadecimal',
    log: false,
    numbersToExpressions: false,
    renameGlobals: false,
    selfDefending: false,
    simplify: true,
    splitStrings: true,
    stringArray: true,
    stringArrayCallsTransform: true,
    stringArrayCallsTransformThreshold: 0.5,
    stringArrayEncoding: [],
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayWrappersCount: 1,
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersMaxCount: 2,
    stringArrayWrappersType: 'function',
    stringArrayThreshold: 0.75,
    unicodeEscapeSequence: false,
  }
};

const commitHash = child
    .execSync("git rev-parse --short HEAD")
    .toString()
    .trim();

const commitDate = child
    .execSync("git log -1 --format=%cd --date=format:%Y-%m-%d")
    .toString()
    .trim();

export default defineConfig({
    plugins: [
        wasm(),
        nodePolyfills(),
        mkcert(),
        vitePluginBundleObfuscator(defaultObfuscatorConfig)
    ],
    server: {
        https: true,
        cors: { origin: "*" },
        mimeTypes: {
            'application/wasm': ['wasm']
        }
    },
    base: "/usdt/",
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
        __GIT_DATE__: JSON.stringify(commitDate),
    },
});