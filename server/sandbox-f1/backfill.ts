import { createReadStream, openSync, readSync, closeSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { iterateSessionCaptureRecordsAsync, type SessionCaptureRecord } from "@raceiq/capture-formats/session/framing";
import { iterateSessionCaptureRecordsFromSource, type SessionCaptureSource } from "../session-capture/source-loader";
import { SandboxF1Observer } from "./observer";
import { SandboxF1Store } from "./store";

export interface SandboxBackfillOptions {
  /** Stable identity of the real source capture (prefer manifest ID plus digest). */
  sourceId: string;
  /** Original manifest/capture timestamp, never the time the backfill is run. */
  observedAtMs: number;
  store: SandboxF1Store;
}

/**
 * Feed decompressed, framed native wire records without invoking live parser,
 * recording, broadcasting, main DB or settings. A completed sourceId is idempotent.
 * Untimestamped frames retain the supplied original capture date; no fabricated
 * per-frame timing. Interrupted imports are retained and require another explicit
 * sourceId for retry, rather than silently deleting or duplicating their history.
 */
async function importRecords(source: AsyncIterable<SessionCaptureRecord>, options: SandboxBackfillOptions) {
  if (!options.sourceId || !Number.isFinite(options.observedAtMs)) throw new Error("A stable sourceId and original capture timestamp are required");
  const namespace = `capture:${options.sourceId}`;
  const status = options.store.importStatus(options.sourceId);
  if (status === "complete") return options.store.states(namespace).map((s) => s.session);
  if (status === "incomplete") throw new Error(`Incomplete sandbox import retained for ${options.sourceId}; inspect it before choosing another sourceId`);
  options.store.startImport(options.sourceId);
  const observer = new SandboxF1Observer(options.store, { namespace });
  let lastAt = options.observedAtMs;
  try {
    for await (const record of source) {
      if (record.kind === "frame") {
        lastAt = record.frameTimeMs ?? options.observedAtMs;
        observer.ingestWire(record.frame, lastAt);
      } else if (record.kind === "segment-boundary") observer.finish("incomplete", new Date(lastAt).toISOString());
    }
    observer.finish("incomplete", new Date(lastAt).toISOString());
    options.store.finishImport(options.sourceId);
    return options.store.states(namespace).map((s) => s.session);
  } catch (error) {
    observer.finish("interrupted", new Date(lastAt).toISOString());
    throw error;
  }
}

export async function backfillSandboxF1Records(source: AsyncIterable<Uint8Array>, options: SandboxBackfillOptions) {
  return importRecords(iterateSessionCaptureRecordsAsync(source, { strict: true }), options);
}

/** Native manifest/chunk/archive support. Source is read-only and never rewritten. */
export async function backfillSandboxF1Source(source: SessionCaptureSource, options: SandboxBackfillOptions) {
  if (source.gameId !== "f1-2025") throw new Error("Sandbox backfill accepts F1 25 wire captures only");
  return importRecords(iterateSessionCaptureRecordsFromSource(source, { strict: true, allowLegacyFullFrames: true }), options);
}

/** Streaming .bin or .bin.gz import; decoding is shared with native UDP observer. */
export async function backfillSandboxF1Capture(path: string, options: SandboxBackfillOptions) {
  const fd = openSync(path, "r");
  const signature = Buffer.alloc(2);
  let length: number;
  try { length = readSync(fd, signature, 0, 2, 0); } finally { closeSync(fd); }
  const input = createReadStream(path);
  const gzip = length === 2 && signature[0] === 0x1f && signature[1] === 0x8b;
  const source = gzip ? input.pipe(createGunzip()) : input;
  if (source !== input) input.on("error", (error) => source.destroy(error));
  try { return await backfillSandboxF1Records(source, options); }
  finally { source.destroy(); input.destroy(); }
}
