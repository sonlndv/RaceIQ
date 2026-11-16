import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrameLength, encodeMetaFrame } from "@raceiq/capture-formats/session/framing";
import { SandboxF1Store } from "./store";
import { SandboxF1Observer } from "./observer";
import { decodeSandboxWire } from "./wire";
import { createSandboxF1Routes } from "./routes";
import { backfillSandboxF1Records } from "./backfill";

const opened: SandboxF1Store[] = [];
const directories: string[] = [];
afterEach(() => { for (const s of opened.splice(0)) s.close(); for (const p of directories.splice(0)) rmSync(p, { recursive: true, force: true }); });
const at = Date.parse("2026-11-15T20:00:00Z");

function harness(path = ":memory:") {
  const store = new SandboxF1Store(path); opened.push(store);
  const observer = new SandboxF1Observer(store);
  let sequence = 0;
  return { store, observer, send: (frame: Buffer) => observer.ingestWire(frame, at + sequence++ * 10), state: () => { observer.flush(); return store.get(store.list()[0]!.id)!; } };
}
function wire(id: number, body: Buffer, sequence = 1, uid = 42n, sessionTime = sequence): Buffer {
  const header = Buffer.alloc(29);
  header.writeUInt16LE(2025, 0); header[2] = 25; header[5] = 1; header[6] = id;
  header.writeBigUInt64LE(uid, 7); header.writeFloatLE(sessionTime, 15); header.writeUInt32LE(sequence, 19); header.writeUInt32LE(sequence, 23); header[27] = 0; header[28] = 255;
  return Buffer.concat([header, body]);
}
function session(sequence = 1, trackId = 17, type = 15, uid = 42n, sessionTime = sequence) {
  const body = Buffer.alloc(125); body[6] = type; body.writeInt8(trackId, 7);
  return wire(1, body, sequence, uid, sessionTime);
}
function participants(count = 22, sequence = 2) {
  const body = Buffer.alloc(1 + 57 * count); body[0] = count;
  for (let i = 0; i < count; i++) { const o = 1 + 57 * i; body[o + 3] = i % 10; body.write(`Real slot ${i}`, o + 7, 32); body[o + 39] = i === 21 ? 0 : 1; }
  return wire(4, body, sequence);
}
function laps(lap: number, time: number, sequence: number, options: { invalid?: boolean; last?: number; count?: number; s1?: number; s2?: number; pit?: boolean } = {}) {
  const body = Buffer.alloc(22 * 57 + 2);
  for (let i = 0; i < (options.count ?? 1); i++) {
    const o = i * 57; body.writeUInt32LE(options.last ?? 0, o); body.writeUInt32LE(time, o + 4);
    body.writeUInt16LE(options.s1 ?? 0, o + 8); body.writeUInt16LE(options.s2 ?? 0, o + 11);
    body[o + 32] = i + 1; body[o + 33] = lap; body[o + 34] = options.pit ? 1 : 0; body[o + 37] = options.invalid ? 1 : 0; body[o + 45] = 2;
  }
  return wire(2, body, sequence);
}
function history(car: number, rows: Array<{ time: number; sectors?: [number, number, number]; flags?: number }>, sequence = 10) {
  const body = Buffer.alloc(7 + rows.length * 14); body[0] = car; body[1] = rows.length;
  rows.forEach((r, i) => { const o = 7 + i * 14; body.writeUInt32LE(r.time, o); (r.sectors ?? [30000, 30000, 30000]).forEach((s, sector) => { const off = o + 4 + 3 * sector; body.writeUInt16LE(s % 60000, off); body[off + 2] = Math.floor(s / 60000); }); body[o + 13] = r.flags ?? 15; });
  return wire(11, body, sequence);
}
function event(code: string, sequence: number) { return wire(3, Buffer.from(code), sequence); }

describe("native Austria race sandbox capture", () => {
  test("all 22 participant slots retain invalid sector flags, zero timings stay null, no player readiness dependency", () => {
    const h = harness(); h.send(session()); h.send(participants());
    for (let car = 0; car < 22; car++) h.send(history(car, [{ time: 90000, flags: car % 2 ? 14 : 15 }, { time: 0, sectors: [0, 0, 0], flags: 0 }], 10 + car));
    const state = h.state();
    expect(state.drivers).toHaveLength(22); expect(state.session.lapCount).toBe(22);
    expect(state.drivers[21]!.telemetryRestricted).toBe(true);
    expect(state.drivers[21]!.laps[0]).toMatchObject({ valid: false, status: "invalid", completed: true, sectorValid: [true, true, true], lapTimeSec: 90 });
    expect(state.drivers[0]!.laps[0]!.status).toBe("history");
    expect(state.drivers.every((d) => d.currentLap === null)).toBe(true);
  });

  test("current-lap transition persists invalid lap without SessionHistory, not just clean laps", () => {
    const h = harness(); h.send(session()); h.send(participants(1));
    h.send(laps(1, 45000, 3, { invalid: true, s1: 30000 }));
    h.send(laps(1, 85000, 4, { invalid: true, s1: 30000, s2: 30000 }));
    h.send(laps(2, 1000, 5, { last: 92000 }));
    expect(h.state().drivers[0]!.laps).toHaveLength(1);
    expect(h.state().drivers[0]!.laps[0]).toMatchObject({ lapNumber: 1, valid: false, completed: true, status: "invalid", lapTimeSec: 92, sectorsSec: [30, 30, 32] });
    expect(h.store.list()[0]!.lapCount).toBe(1);
  });

  test("history arriving before LapData completion merges once, invalidation never erased", () => {
    const h = harness(); h.send(session()); h.send(participants(1));
    h.send(laps(1, 85000, 3, { invalid: true, s1: 30000, s2: 30000 }));
    h.send(history(0, [{ time: 90000 }], 4));
    h.send(laps(2, 1000, 5, { last: 90000 }));
    h.send(history(0, [{ time: 90000 }], 6));
    const saved = h.state().drivers[0]!.laps;
    expect(saved).toHaveLength(1); expect(saved[0]!.valid).toBe(false); expect(saved[0]!.source).toBe("lap-data+session-history");
  });

  test("FLBK preserves old complete and partial attempts; changed and repeated snapshots never overwrite", () => {
    const h = harness(); h.send(session()); h.send(participants(1));
    h.send(history(0, [{ time: 90000, flags: 14 }], 3));
    h.send(laps(2, 40000, 4, { s1: 30000 })); h.send(event("FLBK", 5));
    h.send(history(0, [{ time: 88000, sectors: [29000, 29000, 30000] }], 6));
    h.send(history(0, [{ time: 88000, sectors: [29000, 29000, 30000] }], 7));
    h.send(history(0, [{ time: 90000, flags: 14 }], 8));
    const saved = h.state().drivers[0]!.laps;
    expect(saved).toHaveLength(3);
    expect(saved.filter((l) => l.lapNumber === 1).map((l) => [l.attempt, l.lapTimeSec, l.valid])).toEqual([[1, 90, false], [2, 88, true]]);
    expect(saved.find((l) => l.lapNumber === 2)).toMatchObject({ status: "flashback", completed: false, lapTimeSec: 40 });
  });

  test("identical time after a flashback is still a separate live attempt", () => {
    const h = harness(); h.send(session()); h.send(participants(1));
    h.send(laps(1, 80000, 3)); h.send(laps(2, 1000, 4, { last: 90000 })); h.send(history(0, [{ time: 90000 }], 5));
    h.send(event("FLBK", 6)); h.send(laps(1, 70000, 7)); h.send(laps(2, 1000, 8, { last: 90000 })); h.send(history(0, [{ time: 90000 }], 9));
    expect(h.state().drivers[0]!.laps.filter((l) => l.lapNumber === 1)).toHaveLength(2);
  });

  test("stale history with identical lap total cannot overwrite different flashback sectors or validity", () => {
    const h = harness(); h.send(session()); h.send(history(0, [{ time: 90000, flags: 14 }], 2)); h.send(event("FLBK", 3));
    h.send(laps(1, 85000, 4, { s1: 29000, s2: 31000 })); h.send(laps(2, 1000, 5, { last: 90000 }));
    h.send(history(0, [{ time: 90000, flags: 14 }], 6));
    const attempts = h.state().drivers[0]!.laps.filter((l) => l.lapNumber === 1);
    expect(attempts).toHaveLength(2); expect(attempts[0]!.valid).toBe(false);
    expect(attempts[1]).toMatchObject({ valid: true, sectorsSec: [29, 31, 30], attempt: 2 });
  });

  test("retransmitted FLBK frame cannot close a newly observed attempt", () => {
    const h = harness(); h.send(session()); h.send(laps(1, 40000, 2)); h.send(event("FLBK", 3)); h.send(laps(1, 10000, 4)); h.send(event("FLBK", 3));
    const state = h.state(); expect(state.drivers[0]!.laps).toHaveLength(1); expect(state.drivers[0]!.currentLap!.lapTimeSec).toBe(10);
  });

  test("missing FLBK and rewind to zero retains invalid partial, skipped lap numbers never fabricated", () => {
    const h = harness(); h.send(session());
    h.send(laps(1, 40000, 3, { invalid: true })); h.send(laps(1, 0, 4)); h.send(laps(1, 10000, 5)); h.send(laps(3, 1000, 6, { last: 90000 }));
    const saved = h.state().drivers[0]!.laps;
    expect(saved).toHaveLength(2); expect(saved[0]).toMatchObject({ valid: false, status: "flashback", completed: false });
    expect(saved[1]).toMatchObject({ status: "incomplete", completed: false });
    expect(saved.every((l) => l.lapNumber === 1)).toBe(true);
    expect(h.state().drivers[0]!.name).toBe("");
  });

  test("late Participants enrich an already captured active slot, unused 22-slot entries stay absent", () => {
    const h = harness(); h.send(session()); h.send(laps(1, 40000, 3, { invalid: true })); h.send(laps(2, 1000, 4, { last: 90000 })); h.send(participants(1, 5));
    const state = h.state(); expect(state.drivers).toHaveLength(1); expect(state.drivers[0]!.name).toBe("Real slot 0"); expect(state.drivers[0]!.laps[0]!.valid).toBe(false);
  });

  test("SEND closes partials but trailing history enriches same closed generation", () => {
    const h = harness(); h.send(session()); h.send(participants(1)); h.send(laps(1, 42000, 3)); h.send(event("SEND", 4)); h.send(history(0, [{ time: 90000 }], 5)); h.send(laps(2, 1000, 6));
    const state = h.state(); expect(h.store.list()).toHaveLength(1); expect(state.session.closed).toBe(true); expect(state.drivers[0]!.currentLap).toBeNull();
    expect(state.drivers[0]!.laps[0]).toMatchObject({ completed: false, lapTimeSec: 42, status: "incomplete" });
    expect(state.drivers[0]!.laps[1]).toMatchObject({ completed: true, lapTimeSec: 90 });
  });

  test("UID0 auxiliary records never switch context; trailing RTMT enriches the scoped SEND driver", () => {
    const h = harness(); h.send(session()); h.send(participants()); h.send(laps(1, 42000, 3, { count: 22 }));
    const buttons = wire(3, Buffer.from("BUTN"), 900, 0n);
    const unscopedHistory = history(0, [{ time: 89000 }], 901); unscopedHistory.writeBigUInt64LE(0n, 7);
    expect(h.send(buttons)).toBe(false);
    expect(h.send(unscopedHistory)).toBe(false);
    expect(h.send(session(902, 17, 15, 0n))).toBe(false);
    expect(h.send(event("SEND", 4))).toBe(true);
    const retirement = wire(3, Buffer.concat([Buffer.from("RTMT"), Buffer.from([0])]), 0, 0n);
    const original = Buffer.from(retirement);
    expect(h.send(retirement)).toBe(true);
    h.send(laps(2, 1000, 5, { count: 22 }));
    const state = h.state();
    expect(h.store.list()).toHaveLength(1);
    expect(state.uid).toBe("42");
    expect(state.session.closed).toBe(true);
    expect(state.drivers).toHaveLength(22);
    expect(state.drivers[0]!.laps).toHaveLength(1);
    expect(state.drivers[0]!.laps[0]).toMatchObject({ completed: false, lapTimeSec: 42, status: "retired" });
    expect(state.drivers[1]!.laps[0]!.status).toBe("incomplete");
    expect(retirement.equals(original)).toBe(true);
  });

  test("UID0 cannot supply a race preamble or close an unrelated session", () => {
    const h = harness();
    const retirement = wire(3, Buffer.concat([Buffer.from("RTMT"), Buffer.from([0])]), 10, 0n);
    expect(h.send(retirement)).toBe(false);
    h.send(participants(22));
    const unknown = history(0, [{ time: 88000 }]); unknown.writeBigUInt64LE(0n, 7);
    h.send(unknown);
    h.send(session());
    h.send(laps(1, 40000, 3));
    const mismatch = Buffer.from(retirement); mismatch[27] = 19;
    expect(h.send(mismatch)).toBe(false);
    expect(h.send(wire(3, Buffer.from("SEND"), 11, 0n))).toBe(false);
    const state = h.state();
    expect(state.session.closed).toBe(false);
    expect(state.drivers).toHaveLength(22);
    expect(state.drivers[0]!.laps).toHaveLength(0);
    expect(state.drivers[0]!.currentLap!.lapTimeSec).toBe(40);
    h.send(session(12, 17, 15, 43n));
    expect(h.send(mismatch)).toBe(false);
    h.observer.flush();
    expect(h.store.list()).toHaveLength(2);
  });

  test("SSTA and process restart distinguish same UID generations and retain checkpointed partial", () => {
    const directory = mkdtempSync(join(tmpdir(), "raceiq-sandbox-f1-")); directories.push(directory);
    const h = harness(join(directory, "history.sqlite")); h.send(session()); h.send(participants(1)); h.send(laps(1, 44000, 3, { invalid: true })); h.observer.flush();
    const next = new SandboxF1Observer(h.store); next.ingestWire(session(4), at + 1000); next.ingestWire(participants(1, 5), at + 1010); next.ingestWire(laps(1, 12000, 6), at + 1020); next.ingestWire(event("SSTA", 7), at + 1030); next.flush();
    const sessions = h.store.list(); expect(sessions).toHaveLength(3); expect(new Set(sessions.map((s) => s.id)).size).toBe(3);
    const first = sessions.find((s) => s.id.endsWith(":0"))!;
    expect(h.store.get(first.id)!.drivers[0]!.laps[0]).toMatchObject({ status: "interrupted", completed: false, lapTimeSec: 44, valid: false });
  });

  test("counter reset closes partial safely, out-of-order LapData cannot rewind current lap", () => {
    const h = harness(); h.send(session(500, 17, 15, 42n, 100)); h.send(laps(4, 40000, 501)); h.send(laps(1, 1000, 400));
    expect(h.state().drivers[0]!.currentLap!.lapNumber).toBe(4);
    h.send(session(1, 17, 15, 42n, 0)); h.observer.flush(); expect(h.store.list()).toHaveLength(2);
    expect(h.store.states("live").find((s) => s.generation === 0)!.drivers[0]!.laps[0]!.status).toBe("reset");
  });

  test("only fully observed valid uninterrupted laps count clean; pit and local caution excluded", () => {
    const h = harness(); h.send(session()); h.send(laps(1, 80000, 2)); h.send(laps(2, 1000, 3, { last: 90000 })); h.send(laps(2, 80000, 4)); h.send(laps(3, 1000, 5, { last: 90000 }));
    const flags = Buffer.alloc(22 * 55); flags[28] = 3; h.send(wire(7, flags, 6)); h.send(laps(3, 80000, 7)); h.send(laps(4, 1000, 8, { last: 90000, pit: true })); h.send(laps(4, 80000, 9, { pit: true })); h.send(laps(5, 1000, 10, { last: 90000 }));
    expect(h.state().drivers[0]!.laps.map((l) => l.status)).toEqual(["history", "clean", "caution", "pit"]);
  });

  test("time trials and Australia are not misrepresented as the real Austria race", () => {
    const h = harness(); h.send(session(1, 0, 18)); h.send(participants()); h.send(history(0, [{ time: 90000 }])); h.send(session(11, 17, 18)); h.observer.flush(); expect(h.store.list()).toHaveLength(0);
  });

  test("bounded malformed array rejection and minute-containing sectors preserve exact wire values", () => {
    expect(decodeSandboxWire(wire(4, Buffer.from([23])))).toBeNull(); expect(decodeSandboxWire(wire(11, Buffer.from([21, 100, 0, 0, 0, 0, 0])))).toBeNull(); expect(decodeSandboxWire(wire(2, Buffer.alloc(57)))).toBeNull();
    const packet = decodeSandboxWire(history(21, [{ time: 180123, sectors: [61001, 62002, 57120], flags: 5 }]));
    expect(packet?.kind).toBe("history"); if (packet?.kind === "history") expect(packet.laps[0]).toMatchObject({ time: 180.123, sectors: [61.001, 62.002, 57.12], flags: 5 });
  });

  test("60Hz current updates stay coalesced; all22 completions checkpoint once per datagram", () => {
    const h = harness(); h.send(session()); h.send(participants()); h.send(laps(1, 10000, 3, { count: 22 })); h.observer.flush(at);
    const save = spyOn(h.store, "save");
    for (let i = 0; i < 60; i++) h.send(laps(1, 10000 + i * 10, 4 + i, { count: 22 }));
    expect(save).toHaveBeenCalledTimes(0);
    h.send(laps(2, 1000, 65, { count: 22, last: 90000 }));
    expect(save).toHaveBeenCalledTimes(1); expect(h.store.list()[0]!.lapCount).toBe(22);
    save.mockRestore();
  });

  test("capture/checkpoint failure remains visible in API coverage", async () => {
    const h = harness(); h.send(session()); h.observer.flush();
    const routes = createSandboxF1Routes(() => h.store, () => {}, () => "disk full");
    const response = await routes.request(`/api/sandbox/f1/sessions/${encodeURIComponent(h.store.list()[0]!.id)}`);
    const detail = await response.json();
    expect(detail.coverage.message).toContain("Capture/checkpoint failure observed: disk full");
    expect(detail.coverage.missingData).toBe(true);
  });

  test("API encodes stable session IDs, returns full contract, unknown IDs 404 and no write route", async () => {
    const h = harness(); h.send(session()); h.send(participants(1)); h.send(history(0, [{ time: 90000, flags: 0 }])); h.observer.flush();
    const routes = createSandboxF1Routes(() => h.store);
    const list = await (await routes.request("/api/sandbox/f1/sessions")).json(); const id = list.sessions[0].id;
    expect(list.sessions[0]).toMatchObject({ trackId: 17, trackName: "Austria / Red Bull Ring", driverCount: 1, lapCount: 1, sessionType: "race", closed: false });
    const detail = await (await routes.request(`/api/sandbox/f1/sessions/${encodeURIComponent(id)}`)).json();
    expect(detail.coverage).toMatchObject({ missingData: true }); expect(detail.coverage.packetCount).toBeGreaterThan(0); expect(detail.drivers[0].laps[0].epoch).toBeUndefined();
    expect((await routes.request("/api/sandbox/f1/sessions/missing")).status).toBe(404); expect((await routes.request("/api/sandbox/f1/sessions", { method: "POST" })).status).toBe(404);
  });

  test("offline genuine-wire mechanism consumes timestamps and split record chunks idempotently without a live observer", async () => {
    const h = harness(); const frames = [session(), participants(1), history(0, [{ time: 90000, flags: 14 }])];
    const bytes = Buffer.concat([encodeMetaFrame(frames.length), ...frames.flatMap((frame, i) => [encodeFrameLength(frame.length, at + i * 10), frame])]);
    async function* chunks() { for (let o = 0; o < bytes.length; o += 13) yield bytes.subarray(o, o + 13); }
    const options = { sourceId: "regression-wire-fixture", observedAtMs: at, store: h.store };
    const imported = await backfillSandboxF1Records(chunks(), options); expect(imported).toHaveLength(1); expect(imported[0]!.closed).toBe(true); expect(imported[0]!.startedAt).toBe(new Date(at).toISOString());
    expect(h.store.get(imported[0]!.id)!.drivers[0]!.laps[0]!.valid).toBe(false);
    await backfillSandboxF1Records(chunks(), options); expect(h.store.list()).toHaveLength(1);
  });

  test("failed offline import closes observed partials and never silently replays over prior data", async () => {
    const h = harness(); const frames = [session(), participants(1), laps(1, 44000, 3, { invalid: true })];
    async function* broken() {
      yield Buffer.concat([encodeMetaFrame(frames.length), ...frames.flatMap((frame) => [encodeFrameLength(frame.length, at), frame])]);
      throw new Error("capture read failure");
    }
    const options = { sourceId: "interrupted-regression-fixture", observedAtMs: at, store: h.store };
    await expect(backfillSandboxF1Records(broken(), options)).rejects.toThrow("capture read failure");
    const saved = h.store.states(`capture:${options.sourceId}`);
    expect(saved[0]!.session.closed).toBe(true); expect(saved[0]!.drivers[0]!.laps[0]).toMatchObject({ status: "interrupted", completed: false, valid: false, lapTimeSec: 44 });
    expect(h.store.states("live")).toHaveLength(0);
    await expect(backfillSandboxF1Records(broken(), options)).rejects.toThrow("Incomplete sandbox import retained");
  });

  test("native sector truncation does not duplicate a history/live completion", () => {
    const h = harness(); h.send(session()); h.send(participants(1));
    h.send(laps(1, 70000, 3, { s1: 17588, s2: 32082 }));
    h.send(history(0, [{ time: 71667, sectors: [17588, 32082, 21996] }], 4));
    h.send(laps(2, 1000, 5, { last: 71667 }));
    h.send(history(0, [{ time: 71667, sectors: [17588, 32082, 21996] }], 6));
    const saved = h.state().drivers[0]!.laps;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ lapNumber: 1, completed: true, lapTimeSec: 71.667, sectorsSec: [17.588, 32.082, 21.996], source: "lap-data+session-history" });
  });

  test("partial history is enriched rather than counted as an extra completed or flashback attempt", () => {
    const completed = harness(); completed.send(session()); completed.send(participants(1));
    completed.send(laps(1, 45000, 3, { s1: 30000 }));
    completed.send(history(0, [{ time: 0, sectors: [30000, 0, 0] }], 4));
    completed.send(laps(2, 1000, 5, { last: 90000 }));
    expect(completed.state().drivers[0]!.laps).toHaveLength(1);
    expect(completed.state().drivers[0]!.laps[0]).toMatchObject({ completed: true, lapTimeSec: 90 });
    const interrupted = harness(); interrupted.send(session()); interrupted.send(participants(1));
    interrupted.send(laps(1, 45000, 3, { s1: 30000, invalid: true }));
    interrupted.send(history(0, [{ time: 0, sectors: [30000, 0, 0] }], 4));
    interrupted.send(event("FLBK", 5));
    expect(interrupted.state().drivers[0]!.laps).toHaveLength(1);
    expect(interrupted.state().drivers[0]!.laps[0]).toMatchObject({ completed: false, lapTimeSec: 45, valid: false, status: "flashback" });
  });

  test("session end survives other event codes on the same overall frame", () => {
    const h = harness(); h.send(session()); h.send(participants(1));
    h.send(laps(10, 28144, 3, { s1: 18000 }));
    h.send(event("PENA", 4));
    h.send(event("SEND", 4));
    h.send(event("RTMT", 4));
    const saved = h.state();
    expect(saved.session.closed).toBe(true);
    expect(saved.drivers[0]!.currentLap).toBeNull();
    expect(saved.drivers[0]!.laps).toHaveLength(1);
    expect(saved.drivers[0]!.laps[0]).toMatchObject({ lapNumber: 10, lapTimeSec: 28.144, completed: false, status: "incomplete" });
  });
});
