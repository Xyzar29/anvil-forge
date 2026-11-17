// Anvil's entrypoint: bring the forge up and walk it through the lifecycle
// the contest env expects of it.
//
// The env is the only neighbour this process has inside its pod, and the
// whole conversation with it has three beats:
//
//   1. Serve. The forge built by app.ts listens on a port the kernel picks
//      (asking for port 0), so the suite's own listener on 8080 is never
//      in our way and no port has to be agreed in advance.
//   2. Announce. We POST {"port": <the port we landed on>} to the env's
//      /register; the env notes the address the request arrived from and
//      dials us back at that pair from then on.
//   3. Wait for the word. We poll the env's /done with a pause that grows
//      from a quarter of a second toward two seconds. It answers
//      {"done": false} while the suite is still working and
//      {"done": true} once its export is written; that answer is our cue
//      to exit 0.
//
// With no MAKEFUN_ENV_URL in the environment (a plain local run) there is
// nobody to announce to and nobody to wait on: the forge simply serves
// until it is stopped.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';

/** One call to the env may hang this long before we abandon it. */
const ENV_CALL_TIMEOUT_MS = 30_000;
/** Register is retried this many times before we stop insisting. */
const REGISTER_TRIES = 8;
/** The pause before the first /done poll, and the ceiling it grows to. */
const FIRST_POLL_PAUSE_MS = 250;
const LONGEST_POLL_PAUSE_MS = 2_000;

/** Progress notes go to stderr, keeping stdout out of the forge's way. */
function note(line: string): void {
  process.stderr.write(`anvil: ${line}\n`);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The env's origin with trailing slashes stripped, or null when unset. */
function envOrigin(): string | null {
  const raw = process.env.MAKEFUN_ENV_URL;
  if (raw === undefined) return null;
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed === '' ? null : trimmed;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Tell the env which port the forge landed on, retrying while it may still
 * be starting up beside us. Resolves true once the env holds our address:
 * a 200 means it just took it, a 409 means an earlier try of ours already
 * landed, and either way the env knows where we live.
 */
async function announcePort(origin: string, port: number): Promise<boolean> {
  for (let attempt = 1; attempt <= REGISTER_TRIES; attempt += 1) {
    try {
      const reply = await fetch(`${origin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(ENV_CALL_TIMEOUT_MS),
      });
      await reply.arrayBuffer().catch(() => undefined);
      if (reply.status === 200 || reply.status === 409) return true;
      note(`register answered HTTP ${reply.status} on attempt ${attempt}`);
    } catch (err) {
      note(`register attempt ${attempt} failed: ${describe(err)}`);
    }
    if (attempt < REGISTER_TRIES) await pause(FIRST_POLL_PAUSE_MS * attempt);
  }
  return false;
}

/**
 * Poll /done until the env reports the suite is over. A poll that fails or
 * answers nonsense counts as "not yet": only a body whose done field is
 * exactly true ends the wait.
 */
async function waitUntilDone(origin: string): Promise<void> {
  let misses = 0;
  for (;;) {
    let finished = false;
    try {
      const reply = await fetch(`${origin}/done`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(ENV_CALL_TIMEOUT_MS),
      });
      const body: unknown = await reply.json().catch(() => null);
      finished =
        typeof body === 'object' &&
        body !== null &&
        (body as { done?: unknown }).done === true;
    } catch {
      finished = false;
    }
    if (finished) return;
    const wait = Math.min(
      LONGEST_POLL_PAUSE_MS,
      FIRST_POLL_PAUSE_MS * 2 ** misses,
    );
    misses += 1;
    await pause(wait);
  }
}

/** Listen on a kernel-chosen port; resolves with the port we landed on. */
function bindEphemeral(forge: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    forge.once('error', onError);
    forge.listen(0, () => {
      forge.removeListener('error', onError);
      forge.on('error', (err) => note(`server error: ${describe(err)}`));
      const address = forge.address() as AddressInfo;
      resolve(address.port);
    });
  });
}

async function run(): Promise<void> {
  const forge = createApp();
  const port = await bindEphemeral(forge);
  note(`serving the forge on port ${port}`);

  const origin = envOrigin();
  if (origin === null) {
    note('MAKEFUN_ENV_URL is not set: serving locally, no env lifecycle');
    return;
  }

  if (await announcePort(origin, port)) {
    note(`registered with the env at ${origin}`);
  } else {
    note('the env never confirmed our register; waiting on /done anyway');
  }
  await waitUntilDone(origin);
  note('the env reports done; shutting down');
  forge.close();
  process.exit(0);
}

run().catch((err: unknown) => {
  note(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : describe(err)}`);
  process.exit(1);
});
