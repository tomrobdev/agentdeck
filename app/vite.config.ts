import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
// @ts-expect-error type error without @types/node package
import process from 'node:process';
// @ts-expect-error type error without @types/node package
import { execFileSync } from 'node:child_process';
const host = process.env.TAURI_DEV_HOST;

/** The commit checked out now, or null outside a git checkout. */
function headCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/** In dev the page re-reads the commit when it hot-reloads (src/build.ts), so it never has to guess. */
const commitEndpoint = (): Plugin => ({
  name: 'agentdeck-commit',
  configureServer(server) {
    server.middlewares.use('/__agentdeck/commit', (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ commit: headCommit() }));
    });
  },
});

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [vue(), tailwindcss(), commitEndpoint()],

  // The commit the dashboard was built from; compared with the daemon's to show a banner when they differ.
  define: { __APP_COMMIT__: JSON.stringify(headCommit()) },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ['**/src-tauri/**'],
    },
  },
}));
