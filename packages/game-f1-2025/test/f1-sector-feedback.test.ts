import { describe, expect, test } from "bun:test";
import { F1_HEADER_SIZE, F1_PACKET_IDS, type F1Header } from "@raceiq/capture-formats/f1-2025/f1-wire";
import { F1StateAccumulator } from "../src/f1-state";
import { decodeF1Event, decodeF1LapData, decodeF1SessionHistory } from "../src/f1-packet-decoders";
import { LiveTelemetryProjector } from "@raceiq/telemetry-core/telemetry/live-projector";

function feed(state: F1StateAccumulator, packetId: number, data: Buffer, time = 20, sessionUID = 123n, playerCarIndex = 0) {
  const header: F1Header = { packetFormat: 2025, gameYear: 25, gameMajorVersion: 1, gameMinorVersion: 0,
    packetVersion: 1, packetId, sessionUID, sessionTime: time, frameIdentifier: Math.round(time * 60),
    overallFrameIdentifier: 2000, playerCarIndex, secondaryPlayerCarIndex: 255 };
  return state.feed(header, Buffer.concat([Buffer.alloc(F1_HEADER_SIZE), data]));
}
type Car = { lap?: number; sector?: number; s1?: number; s2?: number; last?: number; clock?: number; invalid?: number; result?: number; position?: number };
function lapData(cars: Car[]) {
  const data = Buffer.alloc(cars.length * 57);
  cars.forEach((car, i) => {
    const o = i * 57;
    data.writeUInt32LE(Math.round((car.last ?? 90) * 1000), o);
    data.writeUInt32LE(Math.round((car.clock ?? 40) * 1000), o + 4);
    for (const [value, ms, min] of [[car.s1 ?? 0, 8, 10], [car.s2 ?? 0, 11, 13]]) {
      data.writeUInt16LE(Math.round((value % 60) * 1000), o + ms);
      data.writeUInt8(Math.floor(value / 60), o + min);
    }
    data.writeUInt8(car.position ?? i + 1, o + 32);
    data.writeUInt8(car.lap ?? 2, o + 33);
    data.writeUInt8(car.sector ?? 0, o + 36);
    data.writeUInt8(car.invalid ?? 0, o + 37);
    data.writeUInt8(car.result ?? 2, o + 45);
  });
  return data;
}
type HistoryLap = [number, number, number, number];
function history(carIndex: number, laps: HistoryLap[]) {
  const data = Buffer.alloc(7 + laps.length * 14);
  data[0] = carIndex; data[1] = laps.length;
  data[3] = 1; data[4] = 1; data[5] = 1; data[6] = 1;
  laps.forEach(([total, s1, s2, s3], i) => {
    const o = 7 + i * 14;
    data.writeUInt32LE(Math.round(total * 1000), o);
    [s1, s2, s3].forEach((value, n) => {
      data.writeUInt16LE(Math.round((value % 60) * 1000), o + 4 + n * 3);
      data[o + 6 + n * 3] = Math.floor(value / 60);
    });
    data[o + 13] = total > 0 ? 15 : 0;
  });
  return data;
}
function fixture(cars: Car[] = [{}, {}, {}], playerCarIndex = 0, sessionUID = 123n) {
  const state = new F1StateAccumulator();
  const session = Buffer.alloc(9); session[7] = 17;
  const participants = Buffer.alloc(1 + cars.length * 57); participants[0] = cars.length;
  cars.forEach((_, i) => { participants[1 + i * 57 + 1] = i; participants[1 + i * 57 + 3] = i;
    participants.write(`Driver ${i}`, 1 + i * 57 + 7); });
  for (const [id, data] of [[F1_PACKET_IDS.MOTION, Buffer.alloc(60 * cars.length)], [F1_PACKET_IDS.SESSION, session],
    [F1_PACKET_IDS.PARTICIPANTS, participants], [F1_PACKET_IDS.LAP_DATA, lapData(cars)],
    [F1_PACKET_IDS.CAR_TELEMETRY, Buffer.alloc(60 * cars.length)]] as const) feed(state, id, data, 20, sessionUID, playerCarIndex);
  return state;
}
const complete: HistoryLap = [90, 30, 30, 30];

describe("F1 all-car sector feedback", () => {
  test("the trailing partial history entry never replaces the completed last-lap pointer", () => {
    const decoded = decodeF1SessionHistory(history(0, [complete, [0, 12, 0, 0]]))!;
    expect(decoded.history).toMatchObject({ lastS1: 30, lastS2: 30, lastS3: 30, bestLapTime: 90 });
    expect(decoded.lapSectors[1]).toEqual({ lapNumber: 2, sectors: { lapTime: 0, s1: 12, s2: 0, s3: 0 } });
    const state = fixture();
    const packet = feed(state, F1_PACKET_IDS.SESSION_HISTORY, history(0, [complete, [0, 12, 0, 0]]))!;
    expect(packet.f1?.grid?.find((car) => car.carIndex === 0)).toMatchObject({ lastLapNumber: 1, lastS1: 30, lastS2: 30, lastS3: 30 });
    expect(packet.f1).toMatchObject({ lastS1: 30, lastS2: 30, lastS3: 30 });
  });

  test("all cars decode native lap, sector durations, validity and terminal status", () => {
    const decoded = decodeF1LapData(lapData([{ sector: 1, s1: 30.001 }, { lap: 4, sector: 2, s1: 61.002, s2: 31.123, invalid: 1, result: 4 }]), 0)!;
    expect(decoded.allCars[1]).toMatchObject({ currentLapNum: 4, sector: 2, sector1Time: 61.002, sector2Time: 31.123, currentLapInvalid: 1, resultStatus: 4 });
    const state = fixture();
    const packet = feed(state, F1_PACKET_IDS.LAP_DATA, lapData([{ sector: 1, s1: 30.001, s2: 99 }, { sector: 2, s1: 31, s2: 32 }, {}]))!;
    expect(packet.f1?.grid?.find((car) => car.carIndex === 0)).toMatchObject({ currentLapNum: 2, currentSector: 1, currentS1: 30.001, currentS2: 0, currentLapValid: true, timingEpoch: 0 });
    expect(packet.f1?.grid?.find((car) => car.carIndex === 1)).toMatchObject({ currentS1: 31, currentS2: 32 });
  });

  test("S3 waits for the lap transition and matching prior S1/S2, including delayed native total", () => {
    const state = fixture([{ lap: 1, sector: 1, s1: 30, last: 0 }]);
    const s2 = feed(state, F1_PACKET_IDS.LAP_DATA, lapData([{ lap: 1, sector: 2, s1: 30, s2: 31, clock: 65, last: 0 }]))!;
    expect(s2.f1?.lastS3).toBe(0);
    const crossed = feed(state, F1_PACKET_IDS.LAP_DATA, lapData([{ lap: 2, sector: 0, clock: 0, last: 0 }]))!;
    expect(crossed.f1?.lastS3).toBe(0);
    const total = feed(state, F1_PACKET_IDS.LAP_DATA, lapData([{ lap: 2, sector: 0, clock: 1, last: 92 }]))!;
    expect(total.f1?.grid?.[0]).toMatchObject({ lastLapNumber: 1, lastS1: 30, lastS2: 31, lastS3: 31 });
  });

  test("delayed history joins by lap and total, with two-millisecond rounding tolerance", () => {
    const state = fixture([{ last: 90.002 }]);
    let packet = feed(state, F1_PACKET_IDS.SESSION_HISTORY, history(0, [complete, [0, 8, 0, 0]]))!;
    expect(packet.f1?.lastS3).toBe(30);
    packet = feed(state, F1_PACKET_IDS.LAP_DATA, lapData([{ lap: 3, last: 91, clock: 1 }]))!;
    expect(packet.f1?.lastS3).toBe(0);
    packet = feed(state, F1_PACKET_IDS.SESSION_HISTORY, history(0, [complete, [91, 30, 30, 31], [0, 1, 0, 0]]))!;
    expect(packet.f1?.grid?.[0]).toMatchObject({ lastLapNumber: 2, lastS3: 31 });
    packet = feed(state, F1_PACKET_IDS.LAP_DATA, lapData([{ lap: 3, last: 91.003, clock: 2 }]))!;
    expect(packet.f1?.lastS3).toBe(0);
  });

  test("missing S2 never fabricates a completed third sector", () => {
    const state = fixture([{ lap: 1, sector: 1, s1: 30, last: 0 }]);
    const packet = feed(state, F1_PACKET_IDS.LAP_DATA, lapData([{ lap: 2, clock: 0, last: 90 }]))!;
    expect(packet.f1?.grid?.[0].lastLapNumber).toBe(0);
    expect(packet.f1?.lastS3).toBe(0);
  });

  test("flashback clears every driver's abandoned split map and stamps a new epoch", () => {
    const state = fixture([{ lap: 3, sector: 2, s1: 30, s2: 30, clock: 70 }]);
    feed(state, F1_PACKET_IDS.SESSION_HISTORY, history(0, [complete, complete]));
    const rewound = feed(state, F1_PACKET_IDS.LAP_DATA, lapData([{ lap: 2, sector: 0, clock: 1 }]), 10)!;
    expect(rewound.f1?.grid?.[0]).toMatchObject({ timingEpoch: 1, currentLapNum: 2, currentS1: 0, lastS3: 0 });
    expect(rewound.f1?.lapSectors?.[3]).toBeUndefined();
    const forward = feed(state, F1_PACKET_IDS.LAP_DATA, lapData([{ lap: 3, clock: 1, last: 90 }]), 11)!;
    expect(forward.f1?.lastS3).toBe(0);
  });

  test("session-best driver identity does not require available sector splits", () => {
    const state = fixture();
    const packet = feed(state, F1_PACKET_IDS.SESSION_HISTORY, history(1, [[89, 0, 0, 0]]))!;
    expect(packet.f1?.grid?.find((car) => car.carIndex === 1)).toMatchObject({ bestLapTime: 89, lastS1: 0, lastS2: 0, lastS3: 0 });
  });

  test("DNF clock clearing is not a flashback and preserves completed prior history", () => {
    const state = fixture([{ lap: 2, sector: 2, s1: 30, s2: 31, clock: 70 }]);
    feed(state, F1_PACKET_IDS.SESSION_HISTORY, history(0, [complete]));
    const packet = feed(state, F1_PACKET_IDS.LAP_DATA, lapData([{ lap: 2, result: 4, clock: 0 }]))!;
    expect(packet.f1?.grid?.[0]).toMatchObject({ timingEpoch: 0, resultStatus: 4, lastLapNumber: 1, lastS3: 30 });
    const active = fixture();
    const classification = Buffer.alloc(47); classification[0] = 1; classification[6] = 4;
    expect(feed(active, F1_PACKET_IDS.FINAL_CLASSIFICATION, classification)?.f1?.grid?.find((car) => car.carIndex === 0)?.resultStatus).toBe(4);
  });

  test("equal lap totals cannot attach a different lap's history splits", () => {
    const state = fixture([{ lap: 3, last: 90 }]);
    const packet = feed(state, F1_PACKET_IDS.SESSION_HISTORY, history(0, [complete]))!;
    expect(packet.f1?.lastS3).toBe(0);
    expect(packet.f1?.grid?.[0].lastLapNumber).toBe(0);
  });

  test("complementary delayed history partials preserve pending native sector evidence", () => {
    const state = fixture([{ lap: 2, sector: 1, s1: 30 }]);
    feed(state, F1_PACKET_IDS.SESSION_HISTORY, history(0, [complete, [0, 0, 31, 0]]));
    const packet = feed(state, F1_PACKET_IDS.LAP_DATA, lapData([{ lap: 3, clock: 1, last: 92 }]))!;
    expect(packet.f1?.grid?.[0]).toMatchObject({ lastLapNumber: 2, lastS1: 30, lastS2: 31, lastS3: 31 });
  });

  test("explicit flashback events invalidate retained clocks before the next lap packet", () => {
    const state = fixture([{ lap: 2, sector: 2, s1: 30, s2: 31 }]);
    expect(feed(state, F1_PACKET_IDS.EVENT, Buffer.from("FLBK"))).toBeNull();
    const packet = feed(state, F1_PACKET_IDS.LAP_DATA, lapData([{ lap: 2, sector: 0, clock: 1 }]))!;
    expect(packet.f1?.grid?.[0]).toMatchObject({ timingEpoch: 1, currentS1: 0, currentS2: 0 });
  });

  test("a missing split packet retains completed native S1 within only its lap identity", () => {
    const state = fixture([{ lap: 2, sector: 1, s1: 30 }]);
    const pending = feed(state, F1_PACKET_IDS.LAP_DATA, lapData([{ lap: 2, sector: 2, s1: 0, s2: 31, clock: 65 }]))!;
    expect(pending.f1?.grid?.[0]).toMatchObject({ currentS1: 30, currentS2: 31 });
    const crossed = feed(state, F1_PACKET_IDS.LAP_DATA, lapData([{ lap: 3, clock: 1, last: 92 }]))!;
    expect(crossed.f1?.grid?.[0]).toMatchObject({ currentS1: 0, currentS2: 0, lastS1: 30, lastS2: 31, lastS3: 31 });
  });

  test("inactive and DNF cars preserve known completed history without inventing a finish", () => {
    const state = fixture([{ result: 1, position: 0 }, { result: 4 }]);
    const packet = feed(state, F1_PACKET_IDS.SESSION_HISTORY, history(1, [complete, [0, 10, 0, 0]]))!;
    expect(packet.f1?.grid?.find((car) => car.carIndex === 1)).toMatchObject({ resultStatus: 4, lastLapNumber: 1, lastS3: 30 });
    expect(packet.f1?.grid?.find((car) => car.carIndex === 0)).toMatchObject({ resultStatus: 1, lastLapNumber: 0, lastS3: 0 });
  });

  test("session change and parser checkpoints preserve only their own sector identities", () => {
    const state = fixture([{ lap: 1, sector: 2, s1: 30, s2: 31, last: 0 }]);
    const restored = new F1StateAccumulator(); restored.restoreCheckpoint(state.captureCheckpoint());
    const packet = feed(restored, F1_PACKET_IDS.LAP_DATA, lapData([{ lap: 2, clock: 0, last: 92 }]))!;
    expect(packet.f1?.lastS3).toBe(31);
    expect(feed(restored, F1_PACKET_IDS.LAP_DATA, lapData([{ lap: 2 }]), 20, 124n)).toBeNull();
    const checkpoint = JSON.parse(new TextDecoder().decode(restored.captureCheckpoint()));
    expect(checkpoint.driverLapSectors.flatMap(([, laps]: [number, unknown[]]) => laps)).toHaveLength(1);
    expect(checkpoint.driverHistory).toEqual([]);
  });

  test("SEND followed by player-19 RTMT records retirement despite stale active LapData", () => {
    const cars = Array.from({ length: 20 }, () => ({ result: 2 }));
    const state = fixture(cars, 19);
    const send = feed(state, F1_PACKET_IDS.EVENT, Buffer.from("SEND"), 20, 123n, 19)!;
    expect(send.f1).toMatchObject({ resultStatus: 2, resultSource: "lap-data" });
    const retirement = Buffer.concat([Buffer.from("RTMT"), Buffer.from([19, 0])]);
    const retired = feed(state, F1_PACKET_IDS.EVENT, retirement, 20, 123n, 19)!;
    expect(retired.f1).toMatchObject({ resultStatus: 7, resultSource: "event" });
    expect(retired.f1?.resultReason).toBeUndefined();
    expect(retired.f1?.grid?.find((car) => car.carIndex === 19)?.resultStatus).toBe(7);
    expect(retired.f1?.grid?.find((car) => car.carIndex === 0)?.resultStatus).toBe(2);
    const stale = feed(state, F1_PACKET_IDS.LAP_DATA, lapData(cars), 21, 123n, 19)!;
    expect(stale.f1).toMatchObject({ resultStatus: 7, resultSource: "event" });
    const restored = new F1StateAccumulator(); restored.restoreCheckpoint(state.captureCheckpoint());
    expect(feed(restored, F1_PACKET_IDS.EVENT, Buffer.from("SEND"), 21, 123n, 19)?.f1).toMatchObject({ resultStatus: 7, resultSource: "event" });
  });

  test("UID0 auxiliaries before SEND and player-19 RTMT preserve the scoped native race and checkpoint", () => {
    const uid = 152518887824620114n;
    const cars = Array.from({ length: 20 }, () => ({ lap: 2, sector: 2, s1: 30, s2: 31, clock: 67.25, last: 90 }));
    const state = fixture(cars, 19, uid);
    feed(state, F1_PACKET_IDS.EVENT, Buffer.concat([Buffer.from("STLG"), Buffer.from([5])]), 20, uid, 19);
    feed(state, F1_PACKET_IDS.EVENT, Buffer.from("LGOT"), 21, uid, 19);
    feed(state, F1_PACKET_IDS.SESSION_HISTORY, history(19, [complete]), 1841.5, uid, 19);
    const beforeAuxiliary = state.captureCheckpoint();
    // The native session-6 tail starts sending UID0 auxiliaries before SEND.
    for (let i = 0; i < 20; i++)
      expect(feed(state, F1_PACKET_IDS.MOTION_EX, Buffer.alloc(1024), 0, 0n, 19)).toBeNull();
    for (let i = 0; i < 30; i++)
      expect(feed(state, F1_PACKET_IDS.EVENT, Buffer.concat([Buffer.from("BUTN"), Buffer.alloc(4)]), 0, 0n, 19)).toBeNull();
    expect(feed(state, F1_PACKET_IDS.EVENT, Buffer.from("DRSE"), 0, 0n, 19)).toBeNull();
    expect(state.captureCheckpoint()).toEqual(beforeAuxiliary);
    const send = feed(state, F1_PACKET_IDS.EVENT, Buffer.from("SEND"), 1841.75, uid, 19)!;
    expect(send).toMatchObject({ sessionUID: uid.toString(), CurrentRaceTime: 1841.75, CurrentLap: 67.25, LastLap: 90 });
    expect(send.f1).toMatchObject({ resultStatus: 2, resultSource: "lap-data", raceStartAt: 21, lastS3: 30 });
    const beforeRetirement = state.captureCheckpoint();
    const header: F1Header = Object.freeze({ packetFormat: 2025, gameYear: 25, gameMajorVersion: 1, gameMinorVersion: 0,
      packetVersion: 1, packetId: F1_PACKET_IDS.EVENT, sessionUID: 0n, sessionTime: 0, frameIdentifier: 0,
      overallFrameIdentifier: 10114, playerCarIndex: 19, secondaryPlayerCarIndex: 255 });
    const source = Buffer.alloc(F1_HEADER_SIZE + 6);
    source.writeUInt16LE(2025, 0); source[2] = 25; source[3] = 1; source[5] = 1; source[6] = F1_PACKET_IDS.EVENT;
    source.writeBigUInt64LE(0n, 7); source.writeFloatLE(0, 15); source.writeUInt32LE(header.overallFrameIdentifier, 23);
    source[27] = 19; source[28] = 255; source.write("RTMT", F1_HEADER_SIZE); source[F1_HEADER_SIZE + 4] = 19;
    const originalSource = Buffer.from(source);
    const retired = state.feed(header, source)!;
    expect(header).toMatchObject({ sessionUID: 0n, sessionTime: 0, playerCarIndex: 19 });
    expect(source).toEqual(originalSource);
    expect(retired).toMatchObject({
      sessionUID: uid.toString(), TimestampMS: 1841750, CurrentRaceTime: 1841.75, CurrentLap: 67.25, LastLap: 90, LapNumber: 2,
    });
    expect(retired.f1).toMatchObject({ resultStatus: 7, resultSource: "event", raceStartAt: 21, lastS1: 30, lastS2: 30, lastS3: 30 });
    expect(retired.f1?.grid?.find((car) => car.carIndex === 19)).toMatchObject({
      resultStatus: 7, timingEpoch: 0, currentLapNum: 2, currentS1: 30, currentS2: 31,
      lastLapNumber: 1, lastLapTime: 90, lastS1: 30, lastS2: 30, lastS3: 30,
    });
    expect(retired.f1?.grid?.find((car) => car.carIndex === 0)?.resultStatus).toBe(2);
    const restored = new F1StateAccumulator(); restored.restoreCheckpoint(beforeRetirement);
    expect(restored.feed(header, source)).toEqual(retired);
    restored.restoreCheckpoint(state.captureCheckpoint());
    expect(feed(restored, F1_PACKET_IDS.EVENT, Buffer.from("BUTN"), 0, 0n, 19)).toBeNull();
    const continued = feed(restored, F1_PACKET_IDS.EVENT, Buffer.from("DRSE"), 1842, uid, 19)!;
    expect(continued).toMatchObject({ sessionUID: uid.toString(), CurrentRaceTime: 1842, CurrentLap: 67.25, LastLap: 90 });
    expect(continued.f1).toMatchObject({ resultStatus: 7, resultSource: "event", lastS3: 30 });
    expect(continued.f1?.grid?.find((car) => car.carIndex === 19)?.timingEpoch).toBe(0);
  });

  test("UID0 evidence without scoped context cannot establish a race or retirement", () => {
    const state = new F1StateAccumulator();
    const empty = state.captureCheckpoint();
    expect(feed(state, F1_PACKET_IDS.MOTION_EX, Buffer.alloc(1024), 0, 0n, 19)).toBeNull();
    expect(feed(state, F1_PACKET_IDS.EVENT, Buffer.concat([Buffer.from("RTMT"), Buffer.from([19, 0])]), 0, 0n, 19)).toBeNull();
    expect(feed(state, F1_PACKET_IDS.LAP_DATA, lapData([{}]), 0, 0n, 19)).toBeNull();
    expect(state.captureCheckpoint()).toEqual(empty);
  });

  test.each([[0, 19], [255, 19], [19, 0], [19, 255]])(
    "UID0 retirement with header player %i and event car %i cannot change scoped player 19",
    (headerPlayer, eventCar) => {
      const state = fixture(Array.from({ length: 20 }, () => ({})), 19);
      const before = state.captureCheckpoint();
      expect(feed(state, F1_PACKET_IDS.EVENT, Buffer.concat([Buffer.from("RTMT"), Buffer.from([eventCar, 0])]), 0, 0n, headerPlayer)).toBeNull();
      expect(feed(state, F1_PACKET_IDS.EVENT, Buffer.from("RTMT"), 0, 0n, 19)).toBeNull();
      expect(state.captureCheckpoint()).toEqual(before);
    },
  );

  test("a real nonzero UID change isolates UID0 retirement and completed lap history", () => {
    const state = fixture();
    feed(state, F1_PACKET_IDS.SESSION_HISTORY, history(0, [complete]));
    expect(feed(state, F1_PACKET_IDS.EVENT, Buffer.concat([Buffer.from("RTMT"), Buffer.from([0, 0])]), 0, 0n)?.f1?.resultStatus).toBe(7);
    const session = Buffer.alloc(9); session[7] = 17;
    expect(feed(state, F1_PACKET_IDS.LAP_DATA, lapData([{}, {}, {}]), 1, 124n)).toBeNull();
    expect(feed(state, F1_PACKET_IDS.MOTION, Buffer.alloc(180), 1, 124n)).toBeNull();
    expect(feed(state, F1_PACKET_IDS.SESSION, session, 1, 124n)).toBeNull();
    const packet = feed(state, F1_PACKET_IDS.CAR_TELEMETRY, Buffer.alloc(180), 1, 124n)!;
    expect(packet).toMatchObject({ sessionUID: "124", CurrentRaceTime: 1 });
    expect(packet.f1).toMatchObject({ resultStatus: 2, resultSource: "lap-data", lastS3: 0 });
    expect(JSON.parse(new TextDecoder().decode(state.captureCheckpoint())).retiredCarIndex).toBeUndefined();
  });

  test("other-car and truncated retirement events cannot retire the player", () => {
    const state = fixture();
    expect(decodeF1Event(Buffer.from("RTMT"))).toBeNull();
    expect(feed(state, F1_PACKET_IDS.EVENT, Buffer.concat([Buffer.from("RTMT"), Buffer.from([1, 0])]))?.f1?.resultStatus).toBe(2);
    expect(feed(state, F1_PACKET_IDS.EVENT, Buffer.from("RTMT"))?.f1?.resultStatus).toBe(2);
  });

  test.each(["FLBK", "SSTA"])("%s clears event retirement in its timing/session lifecycle", (code) => {
    const state = fixture();
    const retirement = Buffer.concat([Buffer.from("RTMT"), Buffer.from([0, 255])]);
    expect(feed(state, F1_PACKET_IDS.EVENT, retirement)?.f1?.resultStatus).toBe(7);
    feed(state, F1_PACKET_IDS.EVENT, Buffer.from(code));
    expect(feed(state, F1_PACKET_IDS.LAP_DATA, lapData([{}, {}, {}]))?.f1).toMatchObject({ resultStatus: 2, resultSource: "lap-data" });
  });

  test("a new session clears retirement, while terminal final classification retains authority", () => {
    const state = fixture();
    feed(state, F1_PACKET_IDS.EVENT, Buffer.concat([Buffer.from("RTMT"), Buffer.from([0, 0])]));
    const classification = Buffer.alloc(47); classification[0] = 1; classification[6] = 4; classification[7] = 2;
    expect(feed(state, F1_PACKET_IDS.FINAL_CLASSIFICATION, classification)?.f1).toMatchObject({
      resultStatus: 4, resultReason: 2, resultSource: "final-classification",
    });
    expect(feed(state, F1_PACKET_IDS.LAP_DATA, lapData([{}]), 20, 124n)).toBeNull();
    expect(JSON.parse(new TextDecoder().decode(state.captureCheckpoint())).retiredCarIndex).toBeUndefined();
  });

  test("canonical protocol 1 carries aligned current sectors and car/lap/epoch identities", () => {
    const state = fixture();
    const packet = feed(state, F1_PACKET_IDS.LAP_DATA, lapData([{ sector: 1, s1: 30 }, { sector: 2, s1: 31, s2: 32, invalid: 1 }, { result: 4 }]))!;
    const projected = new LiveTelemetryProjector().project({ packet, sessionId: 6, receivedAtMs: 1000 });
    const schema = projected.schema!, frame = projected.frame!;
    const read = (id: string) => { const index = schema.definitions.findIndex((definition) => definition.semanticId === id);
      expect(index).toBeGreaterThanOrEqual(0); expect(frame.states?.[index]).toBeUndefined(); return frame.values[index]; };
    expect(schema.protocolVersion).toBe(1);
    expect(read("race.competitor.car-index")).toEqual([0, 1, 2]);
    expect(read("timing.competitor.epoch")).toEqual([0, 0, 0]);
    expect(read("timing.competitor.lap-number")).toEqual([2, 2, 2]);
    expect(read("timing.sector.competitor-current.index")).toEqual([1, 2, 0]);
    expect(read("timing.sector.competitor-current.s1")).toEqual([30, 31, 0]);
    expect(read("timing.sector.competitor-current.s2")).toEqual([0, 32, 0]);
    expect(read("timing.competitor.current-lap-valid")).toEqual([true, false, true]);
    expect(read("race.competitor.result-status")).toEqual([2, 2, 4]);
  });
});