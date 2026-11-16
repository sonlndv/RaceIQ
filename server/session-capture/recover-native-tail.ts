import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Schema } from "effect";
import { ChunkSchema, ManifestSchema, type Manifest } from "@raceiq/capture-splitting";
import { iterateSessionCaptureRecordsFromSource } from "./source-loader";

interface IncompleteTail { id: number; lapNumber: number; rawByteOffset: number | null; rawFrameCount: number | null; captureChunkId: string | null; invalidReason: string | null }
const source = (rawFile: string) => ({ rawFile, source: null, gameId: "f1-2025" as const, carId: "", trackId: "", captureFormatVersion: 1 });
const uid = (frame: Buffer) => frame.length >= 29 && frame.readUInt16LE(0) === 2025 && frame[2] === 25 ? frame.readBigUInt64LE(7) : null;

/** Recover only a uniquely provable terminal F1 fragment; never reinterpret older lap rows. */
export async function recoverNativeIncompleteTail(path: string, manifest: Manifest, lapRows: readonly IncompleteTail[]): Promise<Manifest> {
  if (manifest.gameId !== "f1-2025" || manifest.sourceCoordinates !== "native-wire-v1" || manifest.chunks.length === 0) return manifest;
  const pending = lapRows.filter(lap => lap.captureChunkId === null && (lap.rawFrameCount ?? 0) > 0 && lap.rawByteOffset !== null && lap.rawByteOffset >= manifest.sourceByteLength && (lap.invalidReason === "incomplete" || lap.invalidReason === "incomplete at end of input"));
  if (pending.length !== 1) return manifest;
  const lap = pending[0]!;
  const root = await realpath(dirname(path));
  const last = manifest.chunks.at(-1)!;
  if (basename(last.path) !== last.path) throw new Error("Unsafe terminal capture anchor");
  let expectedUid: bigint | null = null;
  for await (const record of iterateSessionCaptureRecordsFromSource(source(join(root, last.path)), { strict: true, allowLegacyFullFrames: true })) {
    if (record.kind === "frame" && (expectedUid = uid(record.frame)) !== null) break;
  }
  if (expectedUid === null) return manifest;
  const published = new Set(manifest.chunks.map(chunk => chunk.path));
  let candidate: Manifest["chunks"][number] | null = null;
  for (const name of await readdir(root)) {
    if (!name.endsWith(".bin") || published.has(name)) continue;
    const memberPath = join(root, name);
    const info = await lstat(memberPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0) continue;
    let inContext = false, invalid = false, started = false, terminal = false;
    let bootstrapHash: string | undefined, firstOffset: number | undefined, ownedOffset: number | undefined;
    let firstTimestamp: number | undefined, lastTimestamp: number | undefined;
    let nativeOffset = manifest.sourceByteLength, count = 0, owned = 0, trailing = 0;
    let ownedSourceEnd: number | undefined;
    try {
      for await (const record of iterateSessionCaptureRecordsFromSource(source(memberPath), { strict: true, allowLegacyFullFrames: true })) {
        if (!started && record.kind === "parser-bootstrap") {
          if (record.gameId !== "f1-2025" || bootstrapHash !== undefined) { invalid = true; break; }
          bootstrapHash = createHash("sha256").update(record.payload).digest("hex");
          continue;
        }
        if (!started && record.kind === "segment-context") { inContext = true; continue; }
        if (!started && record.kind === "segment-context-end") { inContext = false; continue; }
        if (inContext) continue;
        // F1 also emits session-unscoped (UID 0) packets around retirement.
        // The byte interval and a scoped terminal event prove ownership; a
        // different nonzero UID must still reject the candidate.
        if (record.kind !== "frame") { invalid = true; break; }
        const recordUid = uid(record.frame);
        if (recordUid === null || recordUid !== expectedUid && recordUid !== 0n) { invalid = true; break; }
        started = true;
        firstOffset ??= record.offset;
        firstTimestamp ??= record.frameTimeMs;
        if (owned < lap.rawFrameCount!) lastTimestamp = record.frameTimeMs;
        if (nativeOffset === lap.rawByteOffset) ownedOffset = record.offset;
        if (ownedOffset !== undefined) {
          if (owned < lap.rawFrameCount!) {
            owned++;
            ownedSourceEnd = nativeOffset + (record.frameTimeMs === undefined ? 4 : 12) + record.frame.length;
          }
          else trailing++;
        }
        const frame = record.frame;
        if (frame[6] === 3 && frame.length >= 33) {
          const code = frame.toString("ascii", 29, 33);
          if (code === "SEND" && recordUid === expectedUid || code === "RTMT" && recordUid === expectedUid && frame.length >= 34 && frame[33] === frame[27]) terminal = true;
        }
        nativeOffset += (record.frameTimeMs === undefined ? 4 : 12) + frame.length;
        count++;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code) throw error;
      continue; // An uncommitted/truncated orphan is not recovery evidence.
    }
    if (invalid || !terminal || !bootstrapHash || firstOffset === undefined || ownedOffset === undefined || owned !== lap.rawFrameCount) continue;
    if (candidate) throw new Error("Ambiguous native terminal capture ownership");
    candidate = Schema.decodeUnknownSync(ChunkSchema)({
      id: name.slice(0, -4), kind: "lap", lapId: String(lap.id), lapNumber: lap.lapNumber,
      path: name, byteLength: info.size, firstOrdinal: manifest.sourceRecordCount,
      recordCount: count - trailing, sourceStart: manifest.sourceRecordCount, sourceEnd: manifest.sourceRecordCount + count - trailing,
      sourceByteStart: manifest.sourceByteLength, sourceByteEnd: ownedSourceEnd!, sourceRecordByteOffset: firstOffset,
      ownedFrameByteOffset: ownedOffset, ownedFrameCount: owned, trailingContextFrameCount: trailing,
      parserBootstrapHash: bootstrapHash,
      ...(firstTimestamp === undefined ? {} : { firstTimestamp }), ...(lastTimestamp === undefined ? {} : { lastTimestamp }),
    });
  }
  if (!candidate) return manifest;
  return Schema.decodeUnknownSync(ManifestSchema)({ ...manifest, chunks: [...manifest.chunks, candidate], sourceRecordCount: candidate.sourceEnd, sourceByteLength: candidate.sourceByteEnd });
}
