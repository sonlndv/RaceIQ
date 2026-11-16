import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { packet } from "@raceiq/telemetry-core/test-support/telemetry/resolver";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import type { ComparisonData } from "@raceiq/shared/racing/comparison/types";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { SemanticLapTelemetry } from "../../contracts/replay";
import type { ReplaySession } from "../../contracts/spectate";
import { createCaptureClock } from "../../contracts/replay-evidence";
import { packSemanticLapTelemetry, decodeSemanticLapTelemetry } from "../../contracts/replay-wire";
import { buildReplayEvidence, decodeReplayF1Event, readNativeReplayEvents } from "../../server/replay-evidence";
import { createSpectateController, prepareSpectateLap } from "../../ui/spectate-replay";
import { focusRuns } from "../../ui/spectate-focus";
import { buildSpectateChannels } from "../../ui/spectate-channels";
import { ReplayEvidencePanel } from "../../ui/ReplayEvidencePanel";
import { F1_HEADER_SIZE, F1_PACKET_IDS } from "@raceiq/capture-formats/f1-2025/f1-wire";
import { encodeMetaFrame, encodeFrameLength, encodeParserBootstrapFrame, encodeSegmentContextFrame, encodeSegmentContextEndFrame } from "@raceiq/capture-formats/session/framing";

initGameAdapters({ f1Experiments: true, iracingAdapter: true, ams2Adapter: true });

function meta(overrides: Partial<LapMeta> = {}): LapMeta {
  return { id: 37, sessionId: 6, lapNumber: 37, lapTime: 80, isValid: false, invalidReason: "rewind", classification: "pace", createdAt: "2026-11-16T00:00:00Z", carId: "0", trackId: "17", gameId: "f1-2025", processing: { state: "ready", stage: null, error: null }, ...overrides };
}
function recording(times: readonly number[], observed = times): SemanticLapTelemetry {
  return { lapId: 37, requestedSemanticIds: [], envelopes: times.map((time, index) => ({
    sequence: index, simulator: "f1-2025", observedAt: { domain: "session", milliseconds: observed[index]! * 1000 }, receivedAt: { domain: "session", milliseconds: observed[index]! * 1000 },
    values: Object.entries({ "timing.current-lap": time, "timing.distance-traveled": time * 50, "motion.position-x": index * 2, "motion.position-z": 5, "motion.yaw": 0, "motion.speed": 50, "inputs.brake": index }).map(([semanticId, value]) => ({ semanticId, value, state: "ok", freshness: "fresh" })),
  })) };
}
function datagram(id: number, time: number, body: Buffer, player = 2): Buffer {
  const header = Buffer.alloc(F1_HEADER_SIZE);
  header.writeUInt16LE(2025); header[6] = id; header.writeBigUInt64LE(123n, 7); header.writeFloatLE(time, 15); header.writeUInt32LE(Math.round(time * 60), 23); header[27] = player;
  return Buffer.concat([header, body]);
}
function pena(time: number, car = 2, infringement = 7): Buffer {
  return datagram(F1_PACKET_IDS.EVENT, time, Buffer.concat([Buffer.from("PENA"), Buffer.from([4, infringement, car, 255, 5, 37, 0])]));
}

test("capture clock preserves a native reset and a recorder gap as different runs", () => {
  const clock = createCaptureClock(0.101, true);
  const ticks = [[0, 0], [0.05, 0.05], [0.1, 0.1], [0.02, 0.02], [0.07, 0.07], [0.57, 0.57]].map(([native, observed]) => clock(native!, observed!));
  expect(ticks.map(tick => tick.run)).toEqual([0, 0, 0, 1, 1, 2]);
  expect(ticks[3]!.time).toBeGreaterThan(ticks[2]!.time);
  expect(ticks[3]!.reason).toBe("clock-reset");
  expect(ticks[5]!.reason).toBe("capture-gap");
});

test("all 27177 F1 frames survive the 12584th-frame rewind and the final frame remains seekable", () => {
  const times = Array.from({ length: 27177 }, (_, index) => (index < 12584 ? index : index - 12584) / 100);
  const replay = recording(times);
  const lap = prepareSpectateLap(replay);
  expect(lap.samples).toHaveLength(replay.envelopes.length);
  expect(lap.samples.at(-1)!.frame).toBe(replay.envelopes.at(-1)!);
  expect(lap.samples.at(-1)!.nativeTime).toBe(times.at(-1)!);
  expect(lap.samples[12584]!.run).toBe(1);
  for (let index = 1; index < lap.samples.length; index++) expect(lap.samples[index]!.time).toBeGreaterThan(lap.samples[index - 1]!.time);
  const controller = createSpectateController(lap, lap);
  try {
    expect(controller.getSnapshot().canLock).toBe(false);
    controller.seekFrame("a", 27176);
    expect(controller.getSnapshot().a!.frame).toBe(replay.envelopes.at(-1)!);
    expect(controller.getSnapshot().a!.values["inputs.brake"]).toBe(27176);
    expect(controller.sample((lap.samples[12583]!.time + lap.samples[12584]!.time) / 2).a).toBeNull();
  } finally { controller.dispose(); }
});

test("F1 held native ticks use capture progress, preserve every packet and do not invent clock resets", () => {
  const lap = prepareSpectateLap(recording([0, 0, 0.02, 0.02, 0.04], [0, 0.01, 0.02, 0.03, 0.04]));
  expect(lap.samples.map(sample => sample.time)).toEqual([0, 0.01, 0.02, 0.03, 0.04]);
  expect(lap.samples.every(sample => sample.run === 0)).toBe(true);
  expect(lap.alignmentUnavailable).toBeUndefined();
});

test("capture gaps leave pose, telemetry and colored trails unavailable rather than stitched", () => {
  const lap = prepareSpectateLap(recording([0, 0.05, 0.5, 0.55]));
  expect(lap.samples.map(sample => sample.run)).toEqual([0, 0, 1, 1]);
  const controller = createSpectateController(lap, null);
  try { expect(controller.sample(0.25).a).toBeNull(); } finally { controller.dispose(); }
  const runs = focusRuns(lap.samples, { mode: "speed", legend: [], color: () => "--app-accent" });
  expect(runs).toHaveLength(2);
  expect(lap.events!.some(event => event.kind === "capture-gap")).toBe(true);
});

test("rewound comparison retains both recordings but disables misleading alignment and deltas", () => {
  const comparison = { lapA: meta(), lapB: meta({ id: 38 }), traces: { distance: [0, 1, 2, 3], elapsedTimeA: [0, 0.02, 0.04, 0.06], elapsedTimeB: [0, 0.02, 0.04, 0.06] }, timeDelta: [0, 0, 0, 0] } as unknown as ComparisonData;
  const a = prepareSpectateLap(recording([0, 0.02, 0.04, 0.01, 0.03]), comparison);
  const b = prepareSpectateLap(recording([0, 0.02, 0.04, 0.06]), comparison, "b");
  const pair = { gameId: "f1-2025", a, b, comparison } as ReplaySession;
  expect(a.samples).toHaveLength(5);
  expect(b.samples).toHaveLength(4);
  expect(buildSpectateChannels(pair).some(channel => channel.id === "comparison.time-delta")).toBe(false);
});

test("native penalties retain codes, car and lap while unknown reasons remain unavailable", () => {
  const event = decodeReplayF1Event(pena(1));
  expect(event!.penalty).toEqual({ penaltyType: 4, infringementType: 7, carIndex: 2, otherCarIndex: 255, seconds: 5, lapNumber: 37, placesGained: 0 });
  expect(event!.reason).toContain("Corner cutting gained time");
  expect(event!.source).toContain("PENA");
  expect(decodeReplayF1Event(pena(1, 3))).toBeNull();
  expect(decodeReplayF1Event(pena(1, 2, 255))!.reason).toContain("description unavailable");
  const retired = decodeReplayF1Event(datagram(F1_PACKET_IDS.EVENT, 1, Buffer.concat([Buffer.from("RTMT"), Buffer.from([2])])))!;
  expect(retired.kind).toBe("retirement");
  expect(retired.reason).toContain("exact reason unavailable");
  expect(retired.nearbyPose).toBeUndefined();
});

test("retirement infringement codes use the F1 25 table and omit unused penalty sentinels", () => {
  const frame = datagram(F1_PACKET_IDS.EVENT, 1, Buffer.concat([Buffer.from("PENA"), Buffer.from([16, 42, 2, 255, 255, 10, 255])]));
  const event = decodeReplayF1Event(frame)!;
  expect(event.penalty).toMatchObject({ infringementType: 42, seconds: 255, placesGained: 255 });
  expect(event.reason).toContain("Retired terminally damaged");
  expect(event.reason).not.toContain("255 s");
  expect(event.reason).not.toContain("255 places");
  frame[F1_HEADER_SIZE + 5] = 41;
  expect(decodeReplayF1Event(frame)!.reason).toContain("Retired mechanical failure");
});

test("native event loading respects owned offsets, excludes bootstrap context, and locates only fresh poses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "replay-event-evidence-"));
  const file = join(directory, "capture.bin");
  const foreign = pena(0, 2, 255);
  const motion = datagram(F1_PACKET_IDS.MOTION, 1, Buffer.alloc(22 * 60));
  const penalty = pena(1.05);
  const retired = datagram(F1_PACKET_IDS.EVENT, 1.5, Buffer.concat([Buffer.from("RTMT"), Buffer.from([2])]));
  const prefix = Buffer.concat([encodeMetaFrame(), encodeParserBootstrapFrame("f1-2025", Buffer.from("checkpoint")), encodeSegmentContextFrame(), encodeFrameLength(foreign.length), foreign, encodeSegmentContextEndFrame()]);
  const bytes = Buffer.concat([prefix, ...[motion, penalty, retired].flatMap(frame => [encodeFrameLength(frame.length), frame])]);
  await writeFile(file, bytes);
  const packets = [1, 1.05, 1.5].map(time => packet("f1-2025", { TimestampMS: Math.round(time * 1000), CurrentLap: time, PositionX: 10, PositionZ: 20 }));
  const source = { rawFile: file, source: null, gameId: "f1-2025" as const, carId: "0", trackId: "17", captureFormatVersion: 1 };
  try {
    const events = await readNativeReplayEvents(source, prefix.length, 3, packets);
    expect(events.filter(event => event.kind === "penalty")).toHaveLength(1);
    expect(events.find(event => event.kind === "penalty")!.frameIndex).toBe(1);
    expect(events.find(event => event.kind === "penalty")!.nearbyPose).toMatchObject({ x: 10, z: 20 });
    expect(events.find(event => event.kind === "penalty")!.nearbyPose!.offsetSeconds).toBeCloseTo(-0.05, 5);
    expect(events.find(event => event.kind === "retirement")!.nearbyPose).toBeUndefined();
    const filtered = await readNativeReplayEvents(source, prefix.length, 3, packets.slice(1));
    expect(filtered.every(event => event.frameIndex === null && event.nearbyPose === undefined)).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("API evidence separates game validity, RaceIQ validation, clean pace and recording completeness and renders the real reason", () => {
  const packets = [0, 0.05, 0.1, 0.02, 0.07].map((time, index) => packet("f1-2025", { TimestampMS: index * 50, CurrentLap: time, f1: { currentLapInvalid: 0 } as TelemetryPacket["f1"] }));
  const replay = recording([0, 0.05, 0.1, 0.02, 0.07], [0, 0.05, 0.1, 0.15, 0.2]);
  replay.evidence = buildReplayEvidence(meta(), packets);
  expect(replay.evidence.gameValidity.state).toBe("valid");
  expect(replay.evidence.raceiqValidation.state).toBe("invalid");
  expect(replay.evidence.cleanPace.state).toBe("ineligible");
  expect(replay.evidence.recording.state).toBe("partial");
  expect(replay.evidence.runs.map(run => [run.startFrame, run.endFrame])).toEqual([[0, 2], [3, 4]]);
  const lap = prepareSpectateLap(replay);
  const controller = createSpectateController(lap, null);
  try {
    const html = renderToStaticMarkup(createElement(ReplayEvidencePanel, { pair: { gameId: "f1-2025", a: lap, b: null, comparison: { lapA: meta(), lapB: null } } as unknown as ReplaySession, controller }));
    expect(html).toContain("RaceIQ: rewind");
    expect(html).toContain("Game validity");
    expect(html).toContain("Clean pace");
    expect(html).toContain("Original incident time and location unavailable");
    expect(html).toContain("Source:");
    expect(html).toContain("Map location unavailable");
  } finally { controller.dispose(); }
  for (const packed of [false, true]) {
    const wire = packed ? packSemanticLapTelemetry(replay) : replay;
    expect(decodeSemanticLapTelemetry(JSON.parse(JSON.stringify(wire)))).toEqual(replay);
    const invalidReference = structuredClone(wire);
    invalidReference.evidence!.events[0]!.frameIndex = 999;
    expect(() => decodeSemanticLapTelemetry(invalidReference)).toThrow("Invalid semantic replay telemetry");
    const invalidRun = structuredClone(wire);
    invalidRun.evidence!.runs[1]!.startFrame = 4;
    expect(() => decodeSemanticLapTelemetry(invalidRun)).toThrow("Invalid semantic replay telemetry");
  }
});

test("a held pre-reset F1 pose stays unavailable until a distinct post-reset motion update", () => {
  const replay = recording([0, 0.05, 0.01, 0.03, 0.05]);
  const positions = [0, 10, 10, 10, 500];
  replay.envelopes.forEach((frame, index) => { frame.values.find(value => value.semanticId === "motion.position-x")!.value = positions[index]!; });
  const lap = prepareSpectateLap(replay);
  expect(lap.samples[2]!.values["motion.position-x"]).toBeNull();
  expect(lap.samples[3]!.values["motion.position-x"]).toBeNull();
  expect(lap.samples[4]!.values["motion.position-x"]).toBe(500);
  expect(replay.envelopes[2]!.values.find(value => value.semanticId === "motion.position-x")!.value).toBe(10);
  const controller = createSpectateController(lap, null);
  try {
    expect(controller.sample((lap.samples[3]!.time + lap.samples[4]!.time) / 2).a?.pose).toBeNull();
    const runs = focusRuns(lap.samples, { mode: "speed", legend: [], color: () => "--app-accent" });
    expect(runs.every(run => !run.points.some(point => point.x > 10 && point.x < 500))).toBe(true);
  } finally { controller.dispose(); }
});

test("FLBK evidence creates a source-identified run boundary even before native clocks rewind", () => {
  const body = Buffer.alloc(12);
  body.write("FLBK"); body.writeUInt32LE(30, 4); body.writeFloatLE(0.5, 8);
  const event = decodeReplayF1Event(datagram(F1_PACKET_IDS.EVENT, 1, body))!;
  expect(event.reason).toContain("0.500");
  expect(event.source).toContain("FLBK");
  const replay = recording([0, 0.05, 0.1]);
  const packets = [0, 0.05, 0.1].map(time => packet("f1-2025", { TimestampMS: time * 1000, CurrentLap: time }));
  replay.evidence = buildReplayEvidence(meta(), packets, [{ ...event, frameIndex: 1 }]);
  const lap = prepareSpectateLap(replay);
  expect(lap.samples.map(sample => sample.run)).toEqual([0, 1, 1]);
  expect(lap.alignmentUnavailable).toContain("clock reset");
  const controller = createSpectateController(lap, null);
  try { expect(controller.sample(0.025).a).toBeNull(); } finally { controller.dispose(); }
});
