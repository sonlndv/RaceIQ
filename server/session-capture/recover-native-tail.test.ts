import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Schema } from "effect";
import { ManifestSchema } from "@raceiq/capture-splitting";
import { encodeFrameLength, encodeMetaFrame, encodeParserBootstrapFrame } from "@raceiq/capture-formats/session/framing";
import { recoverNativeIncompleteTail } from "./recover-native-tail";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
function frame(code: string | null, uid = 42n) {
  const bytes = Buffer.alloc(code ? 36 : 29);
  bytes.writeUInt16LE(2025); bytes[2] = 25; bytes[6] = code ? 3 : 2; bytes.writeBigUInt64LE(uid, 7); bytes[27] = 19;
  if (code) bytes.write(code, 29, "ascii");
  return bytes;
}
const record = (bytes: Buffer, at = 1000) => Buffer.concat([encodeFrameLength(bytes.length, at), bytes]);
async function fixture(uid = 42n, terminal = true) {
  const directory = await mkdtemp(join(tmpdir(), "raceiq-tail-recovery-")); directories.push(directory);
  const anchor = record(frame(null));
  const path = join(directory, "capture-manifest.json");
  await writeFile(join(directory, "anchor.bin"), Buffer.concat([encodeMetaFrame(), anchor]));
  const sourceEnd = 12 + anchor.length;
  const manifest = Schema.decodeUnknownSync(ManifestSchema)({ version: 3, gameId: "f1-2025", sourceRevision: "fixture", sourceCoordinates: "native-wire-v1", sourceByteLength: sourceEnd, sourceRecordCount: 1,
    chunks: [{ id: "anchor", kind: "auxiliary", path: "anchor.bin", byteLength: sourceEnd, firstOrdinal: 0, recordCount: 1, sourceStart: 0, sourceEnd: 1, sourceByteStart: 12, sourceByteEnd: sourceEnd, sourceRecordByteOffset: 12 }],
  });
  const prefix = Buffer.concat([encodeMetaFrame(), encodeParserBootstrapFrame("f1-2025", Buffer.from("checkpoint"))]);
  const lead = record(frame(null, uid));
  const owned = record(frame(null, uid), 1010);
  const end = record(frame(terminal ? "SEND" : null, uid), 1020);
  const bytes = Buffer.concat([prefix, lead, owned, end]);
  await writeFile(join(directory, "tail.bin"), bytes);
  const lap = { id: 2, lapNumber: 10, rawByteOffset: sourceEnd + lead.length, rawFrameCount: 2, captureChunkId: null, invalidReason: "incomplete" };
  return { directory, path, manifest, lap, bytes, prefix, lead, owned, end };
}

test("terminal recovery binds only the recorded incomplete interval and preserves source bytes", async () => {
  const f = await fixture();
  const recovered = await recoverNativeIncompleteTail(f.path, f.manifest, [f.lap]);
  expect(recovered.chunks[0]).toEqual(f.manifest.chunks[0]);
  expect(recovered.chunks[1]).toMatchObject({ lapId: "2", lapNumber: 10, recordCount: 3, ownedFrameCount: 2, ownedFrameByteOffset: f.prefix.length + f.lead.length, sourceByteStart: f.manifest.sourceByteLength, sourceByteEnd: f.manifest.sourceByteLength + f.lead.length + f.owned.length + f.end.length });
  expect(await readFile(join(f.directory, "tail.bin"))).toEqual(f.bytes);
});

test("terminal packets after a stale partial snapshot remain trailing context, not invented lap frames", async () => {
  const f = await fixture();
  const recovered = await recoverNativeIncompleteTail(f.path, f.manifest, [{ ...f.lap, rawFrameCount: 1 }]);
  expect(recovered.chunks[1]).toMatchObject({ ownedFrameCount: 1, trailingContextFrameCount: 1, recordCount: 2, sourceByteEnd: f.manifest.sourceByteLength + f.lead.length + f.owned.length });
  expect(await readFile(join(f.directory, "tail.bin"))).toEqual(f.bytes);
});

test("unscoped auxiliary and retirement records preserve bytes but cannot alone prove terminal ownership", async () => {
  const f = await fixture();
  const retirement = frame("RTMT", 0n); retirement[33] = 19;
  const auxiliary = record(frame("BUTN", 0n), 1015);
  const bytes = Buffer.concat([f.prefix, f.lead, f.owned, auxiliary, f.end, record(retirement, 1030)]);
  await writeFile(join(f.directory, "tail.bin"), bytes);
  const recovered = await recoverNativeIncompleteTail(f.path, f.manifest, [{ ...f.lap, rawFrameCount: 4 }]);
  expect(recovered.chunks[1]).toMatchObject({ ownedFrameCount: 4, recordCount: 5 });
  expect(await readFile(join(f.directory, "tail.bin"))).toEqual(bytes);
  await writeFile(join(f.directory, "tail.bin"), Buffer.concat([f.prefix, f.lead, f.owned, record(retirement)]));
  expect(await recoverNativeIncompleteTail(f.path, f.manifest, [f.lap])).toBe(f.manifest);
});

test("different session, nonterminal, and nonaligned ownership never become playable references", async () => {
  for (const [uid, terminal] of [[43n, true], [42n, false]] as const) {
    const f = await fixture(uid, terminal);
    expect(await recoverNativeIncompleteTail(f.path, f.manifest, [f.lap])).toBe(f.manifest);
  }
  const f = await fixture();
  expect(await recoverNativeIncompleteTail(f.path, f.manifest, [{ ...f.lap, rawByteOffset: f.lap.rawByteOffset + 1 }])).toBe(f.manifest);
  expect(await recoverNativeIncompleteTail(f.path, f.manifest, [{ ...f.lap, rawFrameCount: 3 }])).toBe(f.manifest);
  await writeFile(join(f.directory, "tail.bin"), f.bytes.subarray(0, -1));
  expect(await recoverNativeIncompleteTail(f.path, f.manifest, [f.lap])).toBe(f.manifest);
});

test("two equally matching terminal files cannot silently choose a lap owner", async () => {
  const f = await fixture();
  await writeFile(join(f.directory, "duplicate.bin"), f.bytes);
  await expect(recoverNativeIncompleteTail(f.path, f.manifest, [f.lap])).rejects.toThrow("Ambiguous native terminal capture ownership");
});
