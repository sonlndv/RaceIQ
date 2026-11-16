import type { ReplaySession, SpectateController } from "../contracts/spectate";

export const REPLAY_EVENT_LABELS = { flashback: "Flashback / reset", invalidation: "Invalidation", penalty: "PENA penalty", retirement: "Retirement / DNF", "capture-gap": "Capture gap" } as const;

/** Independent evidence states: a replayable recording is not necessarily a clean lap. */
export function ReplayEvidencePanel({ pair, controller }: { pair: ReplaySession; controller: SpectateController }) {
  const laps = [pair.a, ...(pair.b ? [pair.b] : [])];
  const alignment = pair.a.alignmentUnavailable ?? pair.b?.alignmentUnavailable;
  return <>
    {alignment && <p role="status" className="text-app-label text-app-text-secondary" data-replay-alignment-unavailable="">{alignment}</p>}
    {laps.map((lap, side) => {
      const evidence = "evidence" in lap.replay ? lap.replay.evidence : undefined;
      if (!evidence && !lap.events?.length) return null;
      return <div key={side} className="text-app-compact text-app-text-secondary" data-replay-evidence={side === 0 ? "a" : "b"}>
        {evidence && <>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {pair.b && <strong>{side === 0 ? "A" : "B"}</strong>}
            {([
              ["Game validity", evidence.gameValidity], ["RaceIQ validation", evidence.raceiqValidation],
              ["Clean pace", evidence.cleanPace], ["Recording", evidence.recording],
            ] as const).map(([label, status]) => <span key={label} title={`${status.reason} Source: ${status.source}`} data-replay-status={label}>{label}: <strong>{status.state}</strong></span>)}
          </div>
          {evidence.raceiqValidation.state === "invalid" && <p data-replay-invalid-reason="">RaceIQ: {evidence.raceiqValidation.reason}</p>}
          {evidence.recording.state !== "complete" && <p>{evidence.recording.reason}</p>}
          {evidence.nativeEvents.state === "unavailable" && <p>{evidence.nativeEvents.reason}</p>}
        </>}
        {!!lap.events?.length && <details className="mt-1" data-replay-events="">
          <summary className="cursor-pointer">{pair.b ? `${side === 0 ? "A" : "B"} · ` : ""}Replay events ({lap.events.length}) · source and location evidence</summary>
          <ul className="mt-1 max-h-32 space-y-1 overflow-y-auto">
            {lap.events.map((event, index) => <li key={index} data-replay-event={event.kind}>
              <button type="button" disabled={event.frameIndex === null} onClick={() => { if (event.frameIndex !== null) controller.seekFrame(side === 0 ? "a" : "b", event.frameIndex); }} className="text-left enabled:hover:text-app-accent disabled:cursor-default">
                <strong>{REPLAY_EVENT_LABELS[event.kind]}</strong>{event.time === null ? " · capture time unavailable" : ` · capture ${event.time.toFixed(3)} s · run ${(event.run ?? 0) + 1}`} — {event.reason}
              </button>
              <p>Source: {event.source}. {event.nearbyPose ? `Map: nearby recorded pose (${event.nearbyPose.offsetSeconds.toFixed(3)} s), not an exact incident location.` : "Map location unavailable: no supported nearby pose and time."}</p>
            </li>)}
          </ul>
        </details>}
      </div>;
    })}
  </>;
}
