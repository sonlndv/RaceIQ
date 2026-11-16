export type ReplayEventKind = "flashback" | "invalidation" | "penalty" | "retirement" | "capture-gap";
export interface ReplayEvent {
  kind: ReplayEventKind;
  /** Index in the existing semantic envelopes, never a second copy of source frames. */
  frameIndex: number | null;
  reason: string;
  source: string;
  /** Native event fields, retained even when their description is unavailable. */
  penalty?: { penaltyType: number; infringementType: number; carIndex: number; otherCarIndex: number; seconds: number; lapNumber: number; placesGained: number };
  /** Only supplied for a recorded, temporally nearby player pose. Not an incident location. */
  nearbyPose?: { x: number; z: number; offsetSeconds: number };
}
export interface ReplayCaptureRun {
  id: number;
  startFrame: number;
  endFrame: number;
  reason: "start" | "clock-reset" | "capture-gap";
}
export interface ReplayEvidence {
  schemaVersion: 1;
  runs: ReplayCaptureRun[];
  events: ReplayEvent[];
  gameValidity: { state: "valid" | "invalid" | "unavailable"; reason: string; source: string };
  raceiqValidation: { state: "valid" | "invalid"; reason: string; source: string };
  cleanPace: { state: "eligible" | "ineligible" | "unavailable"; reason: string; source: string };
  recording: { state: "complete" | "partial" | "unavailable"; reason: string; source: string };
  nativeEvents: { state: "available" | "unavailable"; reason: string };
}

/** Native timing and capture playback are different clocks after a rewind. */
export function createCaptureClock(maximumGapSeconds = 0.101, useObservedProgress = false) {
  let previousNative: number | null = null;
  let previousObserved: number | null = null;
  let previousTime: number | null = null;
  let offset = 0;
  let observedOrigin: number | null = null;
  let observedAnchor = 0;
  let run = 0;
  return (native: number | null, observed: number | null, sourceGap = false, forcedReset = false) => {
    const reset = forcedReset || previousNative !== null && native !== null && native < previousNative - 0.001;
    const observedReset = previousObserved !== null && observed !== null && observed < previousObserved - 0.001;
    let time = native ?? observed ?? previousTime ?? 0;
    const observedStep = observed !== null && previousObserved !== null ? observed - previousObserved : 0;
    let reason: ReplayCaptureRun["reason"] | null = null;
    if (previousTime !== null && (reset || observedReset || !useObservedProgress && time + offset < previousTime - 0.001)) {
      // A reset has no trustworthy elapsed duration. Keep a minimal explicit break,
      // or the recorder's positive interval when it is available.
      offset = previousTime + (observedStep > 0 ? observedStep : 0.001) - time;
      reason = "clock-reset";
      observedOrigin = observed;
      observedAnchor = time + offset;
    }
    time += offset;
    if (observedOrigin === null && observed !== null) { observedOrigin = observed; observedAnchor = time; }
    if (useObservedProgress && observed !== null && observedOrigin !== null) time = Math.max(time, observedAnchor + observed - observedOrigin);
    if (previousTime !== null && (sourceGap || time - previousTime > maximumGapSeconds || observedStep > maximumGapSeconds)) reason ??= "capture-gap";
    if (reason) run++;
    time = Math.max(0, previousTime ?? 0, time);
    previousTime = time;
    if (native !== null) previousNative = native;
    if (observed !== null) previousObserved = observed;
    return { time, run, reason };
  };
}
