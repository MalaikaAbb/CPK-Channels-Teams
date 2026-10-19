/**
 * The managed delivery transport deliberately redacts handler errors: it logs
 * only a fixed-cardinality `errorCategory` ("unknown", "timeout", ...) and
 * never the underlying error. See `safeChannelErrorMetadata` in
 * @copilotkit/channels-intelligence/dist/delivery-transport.js.
 *
 * It also runs deliveries against a bounded slot pool
 * (DEFAULT_MAX_CONCURRENT_DELIVERIES = 8) whose slot is released in a
 * `finally`. A handler that never settles therefore leaks its slot forever;
 * leak all 8 and every later delivery queues behind them, which Intelligence
 * reports as `channel_delivery_stalled`.
 *
 * This wrapper surfaces both: the real error, and enter/exit tracing so a
 * leaked slot is visible as an "enter" with no matching "exit".
 */
let inFlight = 0;
let seq = 0;

export function withErrorLogging<A extends unknown[]>(
  label: string,
  fn: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    const id = ++seq;
    inFlight += 1;
    const started = Date.now();
    console.log(`[delivery] -> ${label}#${id} (in-flight ${inFlight}/8)`);
    try {
      await fn(...args);
      console.log(
        `[delivery] <- ${label}#${id} ok ${Date.now() - started}ms (in-flight ${inFlight - 1}/8)`,
      );
    } catch (error) {
      console.error(`[channel] ${label}#${id} threw:`, error);
      throw error;
    } finally {
      inFlight -= 1;
    }
  };
}
