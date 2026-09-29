import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { parseEnv } from 'node:util';

const envFile = '.env.local';

if (!existsSync(envFile)) {
  console.error(`Missing ${envFile}. Copy .env.example and configure it before starting Vercel Dev.`);
  process.exit(1);
}

// Intentionally let the project-local file override stale shell values. This
// ensures rotated development secrets are picked up on every fresh start.
Object.assign(process.env, parseEnv(readFileSync(envFile, 'utf8')));

const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const port = String(process.env.PORT || '3000');
const child = spawn(command, ['vercel', 'dev', '--listen', port], {
  env: process.env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.on('error', (error) => {
  console.error(`Unable to start Vercel Dev: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
