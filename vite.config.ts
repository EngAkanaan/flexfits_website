import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { parseEnv } from 'node:util';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const envLocalPath = path.resolve(__dirname, '.env.local');
if (existsSync(envLocalPath)) {
  Object.assign(process.env, parseEnv(readFileSync(envLocalPath, 'utf8')));
}

// Runs Vercel-style functions from api/*.ts directly inside Vite's dev server,
// so local dev doesn't depend on `vercel dev`'s Windows-flaky WebSocket proxy.
// Production still uses Vercel's real serverless runtime, untouched by this.
function localApiFunctions(): Plugin {
  return {
    name: 'local-api-functions',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url || '';
        if (!url.startsWith('/api/')) return next();

        const routeName = url.slice('/api/'.length).split('?')[0];
        if (!/^[a-z0-9][a-z0-9-]*$/.test(routeName)) return next();

        const filePath = path.resolve(__dirname, 'api', `${routeName}.ts`);
        if (!existsSync(filePath)) return next();

        try {
          const mod = await server.ssrLoadModule(`/api/${routeName}.ts`);
          const handler = mod.default;
          if (typeof handler !== 'function') return next();
          await handler(req, res);
        } catch (error) {
          console.error(`[api:${routeName}]`, error);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: 'Internal server error.' }));
          }
        }
      });
    },
  };
}

export default defineConfig({
  server: {
    port: 3000,
    host: '0.0.0.0',
  },
  plugins: [react(), localApiFunctions()],
  envPrefix: 'VITE_',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
