import { F1_HEADER_SIZE, F1_PACKET_IDS, parseF1Header } from "@raceiq/capture-formats/f1-2025/f1-wire";
import { iterateSessionCaptureRecordsFromSource, type SessionCaptureSource } from "@raceiq/backend-core/session-capture/source-loader";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import { selectEvaluationLaps, evaluationReasonLabel } from "@raceiq/analysis-core/racing/laps/review-selection";
import { createCaptureClock, type ReplayEvidence, type ReplayEvent } from "../contracts/replay-evidence";

// F1 25 UDP event union, PENA: seven uint8 fields after the four-byte code.
const PENALTY_NAMES = ["Drive-through", "Stop-go", "Grid penalty", "Penalty reminder", "Time penalty", "Warning", "Disqualification", "Removed from formation lap", "Parked too long", "Tyre regulations", "This lap invalidated", "This and next lap invalidated", "This lap invalidated without reason", "This and next lap invalidated without reason", "This and previous lap invalidated", "This and previous lap invalidated without reason", "Retired", "Black flag timer"];
const INFRINGEMENT_NAMES: Record<number, string> = {
  0: "Blocking by slow driving", 1: "Blocking by wrong-way driving", 2: "Reversing off the start line", 3: "Big collision", 4: "Small collision", 5: "Collision failed to hand back position", 6: "Collision failed to hand back multiple positions", 7: "Corner cutting gained time", 8: "Corner cutting overtook one car", 9: "Corner cutting overtook multiple cars", 10: "Crossed pit exit lane", 11: "Ignored blue flags", 12: "Ignored yellow flags", 13: "Ignored drive-through", 14: "Too many drive-throughs", 15: "Drive-through reminder: serve within specified laps", 16: "Drive-through reminder: serve this lap", 17: "Pit lane speeding", 18: "Parked too long", 19: "Ignored tyre regulations", 20: "Too many penalties", 21: "Multiple warnings", 22: "Approaching disqualification", 23: "Tyre regulations select single", 24: "Tyre regulations select multiple", 25: "Lap invalidated corner cutting", 26: "Lap invalidated running wide", 27: "Corner cutting ran wide gained time: minor", 28: "Corner cutting ran wide gained time: significant", 29: "Corner cutting ran wide gained time: extreme", 30: "Lap invalidated wall riding", 31: "Lap invalidated flashback", 32: "Lap invalidated reset to track", 33: "Blocking the pit lane", 34: "Jump start", 35: "Safety car collision", 36: "Illegal safety car overtake", 37: "Safety car exceeding allowed pace", 38: "Virtual safety car exceeding allowed pace", 39: "Formation lap below allowed speed", 40: "Formation lap parking", 41: "Retired mechanical failure", 42: "Retired terminally damaged", 43: "Safety car falling too far back", 44: "Black flag timer", 45: "Unserved stop-go penalty", 46: "Unserved drive-through penalty", 47: "Engine component change", 48: "Gearbox change", 49: "Parc ferme change", 50: "League grid penalty", 51: "Retry penalty", 52: "Illegal time gain", 53: "Mandatory pit stop", 54: "Attribute assigned",
};

export function decodeReplayF1Event(frame: Buffer): ReplayEvent | null {
  if (frame.length < F1_HEADER_SIZE + 4) return null;
  const header = parseF1Header(frame);
  if (header.packetFormat !== 2025 || header.packetId !== F1_PACKET_IDS.EVENT) return null;
  const data = frame.subarray(F1_HEADER_SIZE);
  const code = data.toString("ascii", 0, 4);
  const source = `F1 25 UDP ${code} · session ${header.sessionUID} · frame ${header.overallFrameIdentifier}`;
  if (code === "FLBK" && data.length >= 12) {
    const target = data.readFloatLE(8);
    return { kind: "flashback", frameIndex: null, reason: Number.isFinite(target) && target >= 0 ? `Flashback to native session time ${target.toFixed(3)} s (frame ${data.readUInt32LE(4)}).` : "Flashback reported; target time unavailable.", source };
  }
  if (code === "RTMT" && data.length >= 5 && data[4] === header.playerCarIndex) return { kind: "retirement", frameIndex: null, reason: "Player retired / DNF. RTMT reports retirement, not its cause; exact reason unavailable.", source };
  if (code !== "PENA" || data.length < 11 || data[6] !== header.playerCarIndex) return null;
  const penalty = { penaltyType: data[4]!, infringementType: data[5]!, carIndex: data[6]!, otherCarIndex: data[7]!, seconds: data[8]!, lapNumber: data[9]!, placesGained: data[10]! };
  return { kind: "penalty", frameIndex: null, penalty, reason: `${PENALTY_NAMES[penalty.penaltyType] ?? `Penalty type ${penalty.penaltyType} (description unavailable)`}: ${INFRINGEMENT_NAMES[penalty.infringementType] ?? `infringement ${penalty.infringementType} (description unavailable)`} · car ${penalty.carIndex} · lap ${penalty.lapNumber}${penalty.penaltyType === 4 && penalty.seconds > 0 && penalty.seconds < 255 ? ` · ${penalty.seconds} s` : ""}${penalty.placesGained > 0 && penalty.placesGained < 255 ? ` · ${penalty.placesGained} places gained` : ""}.`, source };
}

/** Read only the owned capture window. Bootstrap/context frames are never player events. */
export async function readNativeReplayEvents(source: SessionCaptureSource, start: number, count: number, packets: readonly TelemetryPacket[]): Promise<ReplayEvent[]> {
  const events: ReplayEvent[] = [];
  let owned = 0;
  let inContext = false;
  let lastMotionTime: number | null = null;
  let previousSessionTime: number | null = null;
  let previousCaptureTime: number | undefined;
  let previousInvalid = false;
  let boundaryPending = false;
  const tail = packets.at(-1), beforeTail = packets.at(-2);
  // The canonical loader may append one synthesized delayed-finish context.
  const onePacketPerFrame = count === packets.length || count === packets.length - 1 && !!tail && !!beforeTail && tail.CurrentLap === tail.LastLap && tail.LapNumber === beforeTail.LapNumber;
  for await (const record of iterateSessionCaptureRecordsFromSource(source, { strict: source.artifact !== undefined })) {
    // Drain archive members so the canonical loader validates CRC/size at EOF.
    if (record.kind === "segment-context") { inContext = true; continue; }
    if (record.kind === "segment-context-end" || record.kind === "segment-boundary" || record.kind === "parser-bootstrap") { inContext = false; lastMotionTime = null; boundaryPending ||= owned > 0; continue; }
    if (inContext || record.offset < start || owned >= count) continue;
    if (owned === 0 && record.offset !== start) throw new Error("Native event window is not aligned to the owned capture");
    owned++;
    if (record.frame.length < F1_HEADER_SIZE) continue;
    const header = parseF1Header(record.frame);
    if (header.packetFormat !== 2025) continue;
    // Unscoped auxiliary clocks cannot establish a reset, gap or map position.
    // Explicit player events still retain their original native provenance.
    if (header.sessionUID === 0n) {
      const event = decodeReplayF1Event(record.frame);
      if (event) events.push(event);
      continue;
    }
    const rewind = previousSessionTime !== null && header.sessionTime < previousSessionTime - 0.001;
    const gap = boundaryPending || previousSessionTime !== null && header.sessionTime - previousSessionTime > 0.101 ||
      record.frameTimeMs !== undefined && previousCaptureTime !== undefined && record.frameTimeMs - previousCaptureTime > 101;
    if (rewind) lastMotionTime = null;
    previousSessionTime = header.sessionTime;
    previousCaptureTime = record.frameTimeMs;
    boundaryPending = false;
    if (header.packetId === F1_PACKET_IDS.MOTION && record.frame.length >= F1_HEADER_SIZE + (header.playerCarIndex + 1) * 60) lastMotionTime = header.sessionTime;
    const nativeMilliseconds = Math.round(header.sessionTime * 1000);
    // A frame reference requires a one-to-one owned window and exact source
    // timestamp. Repeated clocks or filtered parser output are not guessed.
    const ordinal = owned - 1;
    const matched = onePacketPerFrame && packets[ordinal]?.TimestampMS === nativeMilliseconds ? ordinal : -1;
    let event = decodeReplayF1Event(record.frame);
    const source = `F1 25 UDP · native frame ${header.overallFrameIdentifier}`;
    if (!event && rewind) event = { kind: "flashback", frameIndex: null, reason: "Native session clock rewound; a separate captured run is preserved. Exact trigger unavailable.", source };
    if (!event && gap) event = { kind: "capture-gap", frameIndex: null, reason: "Capture gap; no interpolation across missing evidence.", source };
    const lapOffset = F1_HEADER_SIZE + header.playerCarIndex * 57;
    if (header.packetId === F1_PACKET_IDS.LAP_DATA && record.frame.length >= lapOffset + 57) {
      const invalid = record.frame[lapOffset + 37] !== 0;
      if (!event && invalid && !previousInvalid) event = { kind: "invalidation", frameIndex: null, reason: "Game reports the current lap invalid. PENA events, when present, separately report the infringement; otherwise the exact cause is unavailable.", source: `${source} · LAP_DATA currentLapInvalid` };
      previousInvalid = invalid;
    }
    if (!event) continue;
    if (matched >= 0) {
      event.frameIndex = matched;
      const packet = packets[matched]!;
      const age = lastMotionTime === null ? Infinity : header.sessionTime - lastMotionTime;
      // A flashback teleports: a pre-flashback pose cannot locate its destination.
      if ((event.kind !== "flashback" || header.packetId === F1_PACKET_IDS.MOTION) && age >= 0 && age <= 0.1 && Number.isFinite(packet.PositionX) && Number.isFinite(packet.PositionZ)) event.nearbyPose = { x: packet.PositionX, z: packet.PositionZ, offsetSeconds: -age };
    }
    events.push(event);
  }
  if (owned !== count) throw new Error("Native event capture window is incomplete");
  return events;
}

export function buildReplayEvidence(meta: LapMeta, packets: readonly TelemetryPacket[], nativeEvents: ReplayEvent[] = [], nativeStatus: ReplayEvidence["nativeEvents"] = { state: "unavailable", reason: "Native event capture unavailable; no penalty or retirement cause inferred." }): ReplayEvidence {
  const runs: ReplayEvidence["runs"] = [];
  const events = [...nativeEvents];
  const maximumGap = 0.1;
  const clock = createCaptureClock(maximumGap + 0.001, true);
  let invalidSeen = false, validitySeen = false, previousInvalid = false, retiredSeen = false;
  const firstObserved = packets[0]?.extendedRaceIQ?.frameTimeMs ?? packets[0]?.TimestampMS ?? 0;
  const firstNative = packets.find(packet => Number.isFinite(packet.CurrentLap) && packet.CurrentLap >= 0)?.CurrentLap ?? 0;
  const resetFrames = new Set(nativeEvents.filter(event => event.kind === "flashback" && event.frameIndex !== null).map(event => event.frameIndex!));
  const gapFrames = new Set(nativeEvents.filter(event => event.kind === "capture-gap" && event.frameIndex !== null).map(event => event.frameIndex!));
  const nativeEventFrames = new Set(nativeEvents.map(event => `${event.kind}:${event.frameIndex}`));
  for (const [frameIndex, packet] of packets.entries()) {
    const observed = ((packet.extendedRaceIQ?.frameTimeMs ?? packet.TimestampMS) - firstObserved) / 1000;
    const native = Number.isFinite(packet.CurrentLap) && packet.CurrentLap >= 0 ? packet.CurrentLap - firstNative : null;
    const tick = clock(native, Number.isFinite(observed) ? observed : null, gapFrames.has(frameIndex), resetFrames.has(frameIndex));
    if (!runs.length || tick.reason) {
      runs.push({ id: tick.run, startFrame: frameIndex, endFrame: frameIndex, reason: tick.reason ?? "start" });
      if (tick.reason && !nativeEventFrames.has(`${tick.reason === "clock-reset" ? "flashback" : "capture-gap"}:${frameIndex}`)) events.push({ kind: tick.reason === "clock-reset" ? "flashback" : "capture-gap", frameIndex, reason: tick.reason === "clock-reset" ? "Native clock reset; a separate captured run is preserved. A rewind or lap boundary cannot be aligned as clean pace." : "Capture gap: recorded timestamps leave an unavailable interval. Track, trails and metrics are not stitched across it.", source: "Recorded native lap clock / capture timestamps" });
    }
    runs.at(-1)!.endFrame = frameIndex;
    if (packet.f1?.currentLapInvalid !== undefined) {
      validitySeen = true;
      const invalid = packet.f1.currentLapInvalid !== 0;
      if (invalid && !previousInvalid && !nativeEventFrames.has(`invalidation:${frameIndex}`)) events.push({ kind: "invalidation", frameIndex, reason: frameIndex === 0 ? "Game reports this lap already invalid at the first captured sample; original cause and location unavailable." : "Game changed the current-lap validity flag to invalid. Exact cause unavailable unless a separate native event reports it.", source: "F1 25 LAP_DATA currentLapInvalid" });
      previousInvalid = invalid;
      invalidSeen ||= invalid;
    }
    if (!retiredSeen && (packet.f1?.resultStatus === 4 || packet.f1?.resultStatus === 7)) {
      retiredSeen = true;
      if (!events.some(event => event.kind === "retirement")) events.push({ kind: "retirement", frameIndex, reason: "Player retired / DNF according to game result status. Exact cause unavailable.", source: "F1 25 LAP_DATA / FINAL_CLASSIFICATION resultStatus" });
    }
  }
  if (!meta.isValid && !events.some(event => event.kind === "invalidation")) events.push({ kind: "invalidation", frameIndex: null, reason: `RaceIQ validation: ${meta.invalidReason ?? "Lap rejected; specific reason unavailable"}. Original incident time and location unavailable.`, source: "Persisted RaceIQ lap validation (not a game penalty)" });
  const hasReset = runs.some(run => run.reason === "clock-reset");
  const hasGap = runs.some(run => run.reason === "capture-gap");
  const endNative = packets.at(-1)?.CurrentLap ?? 0;
  const coversFinish = meta.lapTime > 0 && endNative >= meta.lapTime - 0.2;
  const partial = meta.invalidReason === "incomplete" || !coversFinish || firstNative > 0.2 || hasGap;
  const selection = selectEvaluationLaps([meta], 1);
  const evaluation = selection.reasonById.get(meta.id)!;
  const excluded = evaluation !== "chosen" || hasReset || hasGap || events.some(event => event.kind === "penalty" || event.kind === "retirement") || invalidSeen || partial;
  return {
    schemaVersion: 1, runs, events,
    gameValidity: { state: validitySeen ? invalidSeen ? "invalid" : "valid" : "unavailable", reason: validitySeen ? invalidSeen ? "At least one captured run was game-invalid." : "Recorded game validity flags are valid; this does not certify clean pace or complete recording." : "No native game-validity flag was available.", source: "Native game lap-validity evidence" },
    raceiqValidation: { state: meta.isValid ? "valid" : "invalid", reason: meta.invalidReason ?? (meta.isValid ? "Persisted lap validation passed." : "Persisted lap validation rejected the lap; reason unavailable."), source: "Persisted RaceIQ lap validation" },
    cleanPace: { state: excluded ? "ineligible" : validitySeen ? "eligible" : "unavailable", reason: excluded ? hasReset ? "Clock-reset attempts are not one clean pace lap." : hasGap || partial ? "Incomplete recording or capture gaps cannot establish clean pace." : invalidSeen ? "Game-invalid recorded run." : evaluation !== "chosen" ? evaluationReasonLabel(evaluation) : "Native penalty or retirement evidence excludes clean pace." : validitySeen ? "Native validity and RaceIQ pace-selection criteria passed for this recording." : "Native validity unavailable; clean pace cannot be certified.", source: "RaceIQ review eligibility plus recorded continuity and game evidence" },
    recording: { state: packets.length ? partial ? "partial" : "complete" : "unavailable", reason: packets.length ? hasGap ? "Capture contains unavailable intervals; all recorded runs remain playable." : partial ? "Only a partial recorded lap is available; all recorded samples remain playable." : "Recorded timing covers the published lap finish." : "No recorded telemetry frames available.", source: "Recorded frame timestamps and native finish timing; independent of lap validity" },
    nativeEvents: nativeStatus,
  };
}
