import { join } from "node:path";
import { resolveDataDir } from "../runtime/config/data-dir";
import { SandboxF1Observer } from "./observer";
import { SandboxF1Store } from "./store";

let store: SandboxF1Store | null = null;
let observer: SandboxF1Observer | null = null;
let lastErrorAt = 0;
let captureError: string | null = null;

/** Latched for this process: a later success cannot undo a recording gap. */
export function getSandboxF1CaptureError(): string | null { return captureError; }

export function getSandboxF1Store(): SandboxF1Store {
  store ??= new SandboxF1Store(join(resolveDataDir(), "sandbox-f1", "history.sqlite"));
  observer ??= new SandboxF1Observer(store);
  return store;
}

/** Called only from native UDP ingress, never from shared parsers/replay. */
export function observeSandboxF1Wire(frame: Buffer, receivedAtMs: number): void {
  if (frame.length < 29 || frame.readUInt16LE(0) !== 2025 || frame[2] !== 25) return;
  try {
    getSandboxF1Store();
    observer!.ingestWire(frame, receivedAtMs);
  } catch (error) {
    captureError = error instanceof Error ? error.message : String(error);
    // Failures remain visible without rejecting a socket callback or flooding logs.
    if (Date.now() - lastErrorAt >= 10000) { console.error("[Sandbox F1] Capture failed:", error); lastErrorAt = Date.now(); }
  }
}

export function flushSandboxF1(): void {
  try { observer?.flush(); }
  catch (error) { captureError = error instanceof Error ? error.message : String(error); console.error("[Sandbox F1] Checkpoint failed:", error); }
}

export function stopSandboxF1(): void {
  try { observer?.finish("interrupted"); }
  catch (error) { captureError = error instanceof Error ? error.message : String(error); console.error("[Sandbox F1] Final checkpoint failed:", error); }
  observer = null;
}
