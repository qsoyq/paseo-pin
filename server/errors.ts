import type { ErrorCode } from "../shared/rpc.ts";
export class PinError extends Error {
  constructor(readonly code: ErrorCode) { super(code); }
}
export function errorCode(error: unknown): ErrorCode {
  return error instanceof PinError ? error.code : "unavailable";
}
export function checkSignal(signal: AbortSignal) {
  if (signal.aborted) throw new PinError(signal.reason instanceof PinError ? signal.reason.code : "cancelled");
}
export async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  // Always consume operation, including when cancellation predates this call.
  // The caller may already have started a promise that rejects during teardown.
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      onAbort = () => reject(new PinError(signal.reason instanceof PinError ? signal.reason.code : "cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]);
  } finally { signal.removeEventListener("abort", onAbort); }
}
