/**
 * Lightweight timing instrumentation for the OM lifecycle.
 *
 * Enabled by setting `OM_TIMING=1` (writes to `om-timing.log` in cwd) or
 * `OM_TIMING=stderr` (writes to stderr). When disabled, `omTime` is a no-op
 * passthrough — no timer, no allocation beyond the fn call itself.
 *
 * Output is one JSON line per measurement so it can be aggregated by a
 * post-processing script.
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.env.OM_TIMING;

const OM_TIMING_LOG = mode && mode !== 'stderr' ? join(process.cwd(), 'om-timing.log') : null;
const OM_TIMING_STDERR = mode === 'stderr';
export const omTimingEnabled = !!mode;

function emit(label: string, durationMs: number, attrs?: Record<string, unknown>) {
  const record = JSON.stringify({ label, durationMs: Number(durationMs.toFixed(3)), ...(attrs ?? {}) });
  if (OM_TIMING_STDERR) {
    process.stderr.write(`[OM:timing] ${record}\n`);
    return;
  }
  if (OM_TIMING_LOG) {
    try {
      appendFileSync(OM_TIMING_LOG, `${record}\n`);
    } catch {
      // ignore
    }
  }
}

export async function omTime<T>(label: string, fn: () => Promise<T>, attrs?: Record<string, unknown>): Promise<T> {
  if (!omTimingEnabled) return fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    emit(label, performance.now() - start, attrs);
  }
}

export function omTimeSync<T>(label: string, fn: () => T, attrs?: Record<string, unknown>): T {
  if (!omTimingEnabled) return fn();
  const start = performance.now();
  try {
    return fn();
  } finally {
    emit(label, performance.now() - start, attrs);
  }
}

/** Manual timer — useful for fire-and-forget operations where the work outlives the caller. */
export function omTimer(label: string, attrs?: Record<string, unknown>) {
  if (!omTimingEnabled) return { stop: () => {} };
  const start = performance.now();
  return {
    stop: (extraAttrs?: Record<string, unknown>) => {
      emit(label, performance.now() - start, { ...attrs, ...extraAttrs });
    },
  };
}
