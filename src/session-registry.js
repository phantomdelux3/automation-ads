/**
 * Every open CloakBrowser context, so a stop request can close them cleanly.
 *
 * Each running Pro browser holds one of the plan's session seats. A clean
 * context.close() frees the seat instantly; a force-kill (taskkill /F, Task
 * Manager, Ctrl+C with no handler) leaves it occupied until the license server
 * times it out (~4 min on free/solo, 15-30 min on team plans). With a 1-seat
 * plan that means "Stop" then "Start" in the dashboard fails with
 * "session limit reached" for several minutes.
 *
 * So: register each context on launch, and on SIGINT / SIGTERM / a
 * {type:'shutdown'} IPC message from the dashboard, close them all first.
 */
const open = new Set();
let installed = false;
let shuttingDown = false;

export function trackContext(context) {
  open.add(context);
  context.once?.('close', () => open.delete(context));
  installHandlers();
  return context;
}

export async function closeAllContexts() {
  const all = [...open];
  open.clear();
  await Promise.allSettled(all.map((c) => c.close()));
}

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (open.size) {
    console.log(`\n■ ${reason} - closing ${open.size} browser session(s) to free the CloakBrowser seat...`);
  }
  // Hard stop if a close hangs, so the process never lingers forever.
  const guard = setTimeout(() => process.exit(1), 20000);
  guard.unref?.();
  try {
    await closeAllContexts();
  } finally {
    process.exit(0);
  }
}

function installHandlers() {
  if (installed) return;
  installed = true;
  process.once('SIGINT', () => shutdown('Interrupted'));
  process.once('SIGTERM', () => shutdown('Stop requested'));
  process.on('message', (msg) => {
    if (msg && msg.type === 'shutdown') shutdown('Stop requested');
  });
  // Listening on the IPC channel must not keep a finished run alive.
  process.channel?.unref?.();
}
