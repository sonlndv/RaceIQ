import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import { F1SessionLifecycle } from "../../src/runtime/f1-session-lifecycle";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function packet(code: string | null, uid = 1n, car = 19) {
  const frame = Buffer.alloc(code ? 36 : 29);
  frame.writeUInt16LE(2025); frame[2] = 25; frame[6] = code ? 3 : 2;
  frame.writeBigUInt64LE(uid, 7); frame[27] = 19;
  if (code) { frame.write(code, 29, "ascii"); frame[33] = car; }
  return frame;
}

test("native end closes once and held telemetry cannot start another recording", () => {
  const state = new F1SessionLifecycle(async () => {}, () => {});
  expect(state.accept(packet(null))).toBe("record");
  expect(state.accept(packet("SEND"))).toBe("finish");
  expect(state.accept(packet("RTMT"))).toBe("ignore");
  expect(state.accept(packet(null))).toBe("ignore");
  expect(state.accept(packet(null, 2n))).toBe("record");
});

test("only player retirement ends player capture and explicit flashback resumes it", () => {
  const state = new F1SessionLifecycle(async () => {}, () => {});
  expect(state.accept(packet("RTMT", 1n, 0))).toBe("record");
  expect(state.accept(packet("RTMT"))).toBe("finish");
  expect(state.accept(packet(null))).toBe("ignore");
  expect(state.accept(packet("FLBK"))).toBe("record");
  expect(state.accept(packet(null))).toBe("record");
  expect(state.accept(packet("SEND"))).toBe("finish");
  expect(state.accept(packet("SSTA"))).toBe("record");
});

test("truncated and non-F1 records cannot terminate capture", () => {
  const state = new F1SessionLifecycle(async () => {}, () => {});
  expect(state.accept(packet("RTMT").subarray(0, 33))).toBe("record");
  const other = packet("SEND"); other.writeUInt16LE(2024);
  expect(state.accept(other)).toBe("record");
  expect(state.accept(Buffer.alloc(0))).toBe("record");
});

test("scoped SEND drains unchanged UID0 retirement, not late gameplay, before one publication", async () => {
  const captured: Buffer[] = [];
  const publications: Buffer[][] = [];
  const errors: unknown[] = [];
  const state = new F1SessionLifecycle(async () => { publications.push([...captured]); }, (error) => errors.push(error), 10);
  const send = (frame: Buffer) => state.handle(frame, async () => { captured.push(frame); });
  const gameplay = packet(null);
  const buttons = packet("BUTN", 0n);
  const drs = packet("DRSE", 0n);
  const motion = packet(null, 0n); motion[6] = 11;
  const end = packet("SEND");
  const retirement = packet("RTMT", 0n);
  const original = Buffer.from(retirement);
  await send(gameplay); await send(buttons); await send(motion); await send(drs);
  await send(end); await send(retirement);
  await send(packet(null)); await send(packet(null, 0n)); await send(packet("RTMT", 0n, 2));
  await state.disconnect();
  expect(publications).toHaveLength(0);
  vi.advanceTimersByTime(30);
  await state.flush();
  expect(publications).toEqual([[gameplay, buttons, motion, drs, end, retirement]]);
  expect(retirement.equals(original)).toBe(true);
  await send(packet(null)); await send(retirement); await state.flush();
  expect(captured).toHaveLength(6);
  expect(publications).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("UID0 does not terminate, resume, or identify a player session", async () => {
  const captured: Buffer[] = [];
  let finalized = 0;
  const state = new F1SessionLifecycle(async () => { finalized++; }, () => {});
  const send = (frame: Buffer) => state.handle(frame, async () => { captured.push(frame); });
  await send(packet("SEND", 0n)); await send(packet("RTMT", 0n));
  expect(captured).toHaveLength(0);
  await send(packet(null));
  await send(packet("RTMT", 0n)); await send(packet("SEND", 0n));
  await state.flush();
  expect(finalized).toBe(0);
  await send(packet("SEND"));
  await send(packet("SSTA", 0n)); await send(packet("FLBK", 0n));
  await state.flush();
  expect(finalized).toBe(1);
  await send(packet(null));
  expect(captured).toHaveLength(3);
});

for (const boundary of [packet(null, 2n), packet("FLBK"), packet("SSTA")]) {
  test(`drain flushes before new UID/resume ${boundary.readBigUInt64LE(7)}:${boundary.toString("ascii", 29, 33)}`, async () => {
    const calls: string[] = [];
    const state = new F1SessionLifecycle(async () => { calls.push("finish"); }, () => {}, 10);
    await state.handle(packet("SEND"), async () => { calls.push("end"); });
    await state.handle(packet("RTMT", 0n), async () => { calls.push("retirement"); });
    await state.handle(boundary, async () => { calls.push("resume"); });
    await state.handle(packet(null, boundary.readBigUInt64LE(7)), async () => { calls.push("lap"); });
    vi.advanceTimersByTime(30);
    await state.flush();
    expect(calls).toEqual(["end", "retirement", "finish", "resume", "lap"]);
    await state.flush();
  });
}

test("stop flush awaits pending record and publication; timer errors are handled", async () => {
  const { promise: blocked, resolve: release } = Promise.withResolvers<void>();
  const calls: string[] = [];
  const state = new F1SessionLifecycle(async () => { calls.push("finish"); }, () => {}, 10);
  const recording = state.handle(packet("SEND"), async () => { await blocked; calls.push("record"); });
  const stopping = state.flush();
  release();
  await recording; await stopping;
  vi.advanceTimersByTime(30);
  await state.flush();
  expect(calls).toEqual(["record", "finish"]);
  const failure = new Error("publication failed");
  const errors: unknown[] = [];
  const failed = new F1SessionLifecycle(async () => { throw failure; }, (error) => errors.push(error), 1);
  await failed.handle(packet("SEND"), async () => {});
  vi.advanceTimersByTime(20);
  await failed.flush();
  expect(errors).toEqual([failure]);
  await failed.flush();
});

test("late nonzero UID packets cannot interrupt a newer session's drain", async () => {
  const calls: string[] = [];
  const state = new F1SessionLifecycle(async () => { calls.push("finish"); }, () => {});
  await state.handle(packet(null), async () => { calls.push("old"); });
  await state.handle(packet(null, 2n), async () => { calls.push("new"); });
  await state.handle(packet("SEND", 2n), async () => { calls.push("end"); });
  await state.handle(packet("SSTA", 1n), async () => { calls.push("stale"); });
  expect(calls).toEqual(["old", "new", "end"]);
  await state.flush();
  expect(calls).toEqual(["old", "new", "end", "finish"]);
});
