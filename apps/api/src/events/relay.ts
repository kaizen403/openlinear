import { logger } from '../logger';
import { getEventBus, startEventBus } from './bus';
import { deliverToLocalClients } from './hub';
import { claimUnpublished, publishOutboxEvent } from './outbox';

const RELAY_INTERVAL_MS = 500;
let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
let subscribed = false;

export async function relayOnce(): Promise<number> {
  const unpublished = await claimUnpublished();
  for (const event of unpublished) {
    await publishOutboxEvent(event);
  }
  return unpublished.length;
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await relayOnce();
  } catch (err) {
    logger.warn({ err }, '[events] outbox relay tick failed');
  } finally {
    ticking = false;
  }
}

export function startOutboxRelay(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, RELAY_INTERVAL_MS);
  timer.unref();
  logger.info('[events] outbox relay started');
}

export function stopOutboxRelay(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export async function startRealtime(): Promise<void> {
  const bus = await startEventBus();
  if (!subscribed) {
    subscribed = true;
    await bus.subscribe((event) => {
      deliverToLocalClients(event);
    });
  }
  if (process.env.OPENLINEAR_OUTBOX_RELAY !== '0') {
    startOutboxRelay();
  }
}

export { getEventBus };
