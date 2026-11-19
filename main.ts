// forge-core: a GitHub-compatible git forge in one process.
// Lifecycle: listen on an ephemeral port, register it with the environment, serve until told we are done.
import { startServer } from './src/server.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL || '').replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.on('uncaughtException', (e) => console.error('[forge-core] uncaught', e));
process.on('unhandledRejection', (e) => console.error('[forge-core] unhandled', e));

async function register(port) {
  let wait = 100;
  for (;;) {
    try {
      const res = await fetch(ENV_URL + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port }) });
      await res.arrayBuffer().catch(() => null);
      if (res.ok || res.status === 409) return;
      console.error('[forge-core] register answered HTTP ' + res.status);
    } catch (e) {
      console.error('[forge-core] register failed: ' + ((e && e.message) || e));
    }
    await sleep(wait);
    wait = Math.min(wait * 2, 2000);
  }
}

async function waitUntilDone() {
  let wait = 250;
  for (;;) {
    await sleep(wait);
    try {
      const res = await fetch(ENV_URL + '/done');
      const body = await res.json().catch(() => null);
      if (body && body.done === true) return;
    } catch {
      // the environment may be busy; keep polling
    }
    wait = Math.min(Math.round(wait * 1.5), 2000);
  }
}

const server = startServer();
const wantPort = ENV_URL === '' && process.env.PORT ? Number(process.env.PORT) : 0;
server.listen(wantPort, '0.0.0.0', async () => {
  const port = server.address().port;
  console.error('[forge-core] listening on ' + port);
  if (ENV_URL === '') {
    if (process.env.PORT) return; // standalone mode for local use
    console.error('[forge-core] MAKEFUN_ENV_URL is not set');
    process.exit(1);
  }
  await register(port);
  await waitUntilDone();
  process.exit(0);
});
