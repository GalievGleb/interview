import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

import { waitForOwnedVite } from './source-ui-vite-guard.mjs';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(toolsDir, '..');
const viteCli = path.join(desktopRoot, 'node_modules', 'vite', 'bin', 'vite.js');

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.equal(typeof address, 'object');
  return address.port;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

test('occupied renderer port rejects the exited strict-port Vite child', async () => {
  const staleServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/javascript' });
    response.end('export default "stale-run";');
  });
  const port = await listen(staleServer);
  const child = spawn(
    process.execPath,
    [viteCli, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: desktopRoot, stdio: 'ignore', windowsHide: true },
  );

  try {
    await assert.rejects(
      waitForOwnedVite({
        child,
        probeUrl: `http://127.0.0.1:${port}/source-ui-nonce.js`,
        expectedNonce: 'current-run',
        timeoutMs: 5_000,
        pollMs: 20,
      }),
      /Vite exited before serving the current source identity/,
    );
  } finally {
    if (child.exitCode == null) child.kill();
    await close(staleServer);
  }
});

test('healthy child is accepted only when the served nonce matches this run', async () => {
  const currentNonce = 'nonce-for-this-run';
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/javascript' });
    response.end(`export default ${JSON.stringify(currentNonce)};`);
  });
  const port = await listen(server);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });

  try {
    await waitForOwnedVite({
      child,
      probeUrl: `http://127.0.0.1:${port}/source-ui-nonce.js`,
      expectedNonce: currentNonce,
      timeoutMs: 2_000,
      pollMs: 20,
    });
    assert.equal(child.exitCode, null);
  } finally {
    child.kill();
    await close(server);
  }
});
