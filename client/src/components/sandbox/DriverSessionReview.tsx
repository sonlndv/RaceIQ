import { useId } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatLabel, formatLapTime, formatSector, formatTimestamp, type SandboxDriver, type SandboxLap } from "./session-data";

export function cleanPace(laps: SandboxLap[]) {
  let count = 0;
  let total = 0;
  let best: number | null = null;
  for (const lap of laps) {
    if (lap.status !== "clean" || !lap.completed || lap.valid !== true || lap.lapTimeSec === null || !Number.isFinite(lap.lapTimeSec) || lap.lapTimeSec <= 0) continue;
    count++;
    total += lap.lapTimeSec;
    best = best === null ? lap.lapTimeSec : Math.min(best, lap.lapTimeSec);
  }
  return { count, best, average: count > 0 ? total / count : null };
}

function Validity({ valid }: { valid: boolean | null }) {
  return <span className={valid === false ? "text-status-error" : "text-app-text-secondary"}>{valid === true ? "Valid" : valid === false ? "Invalid" : "Unknown"}</span>;
}

function SectorTimes({ sectors }: { sectors: [number | null, number | null, number | null] }) {
  return <>{sectors.map((sector, index) => <td key={index} className="px-3 py-3 text-right font-mono tabular-nums">{formatSector(sector)}</td>)}</>;
}

export function DriverSessionReview({ driver, expanded, onToggle }: { driver: SandboxDriver; expanded: boolean; onToggle: () => void }) {
  const historyId = useId();
  const pace = cleanPace(driver.laps);
  const completedCount = driver.laps.filter((lap) => lap.completed).length;
  const incompleteCount = driver.laps.length - completedCount;
  return (
    <article className="min-w-0 overflow-hidden rounded-lg border border-app-border bg-app-surface-alt/20">
      <button type="button" aria-expanded={expanded} aria-controls={historyId} onClick={onToggle} className="grid w-full gap-3 p-4 text-left hover:bg-app-surface-hover/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-app-accent sm:grid-cols-[minmax(0,1fr)_auto]">
        <span className="flex min-w-0 items-start gap-2">
          {expanded ? <ChevronDown aria-hidden="true" size={18} className="mt-0.5 shrink-0" /> : <ChevronRight aria-hidden="true" size={18} className="mt-0.5 shrink-0" />}
          <span className="min-w-0">
            <span className="block break-words font-semibold text-app-text">{driver.name || `Unnamed participant · slot ${driver.carIndex + 1}`} {driver.isPlayer && <span className="ml-1 text-xs font-normal text-app-accent">You</span>}</span>
            <span className="mt-1 block text-xs text-app-text-muted">Car slot {driver.carIndex + 1}{driver.teamId !== null ? ` · Team ID ${driver.teamId}` : ""}{driver.telemetryRestricted ? " · Telemetry restricted by game" : ""}</span>
            <span className="mt-2 block text-xs text-app-text-secondary">{driver.laps.length} recorded attempts · {completedCount} completed · {incompleteCount} incomplete</span>
          </span>
        </span>
        <span className="grid grid-cols-3 gap-3 pl-6 text-xs sm:pl-0 sm:text-right">
          <span><span className="block text-app-text-muted">Clean laps</span><span className="mt-1 block font-mono tabular-nums">{pace.count}</span></span>
          <span><span className="block text-app-text-muted">Clean best</span><span className="mt-1 block font-mono tabular-nums">{formatLapTime(pace.best)}</span></span>
          <span><span className="block text-app-text-muted">Clean average</span><span className="mt-1 block font-mono tabular-nums">{formatLapTime(pace.average)}</span></span>
        </span>
      </button>
      {expanded && (
        <div id={historyId} className="border-t border-app-border">
          {driver.telemetryRestricted && <p className="px-4 pt-3 text-xs text-app-text-muted">Only timings actually received are shown. The game may withhold this driver's telemetry.</p>}
          <p className="px-4 py-3 text-xs text-app-text-muted">Every observed attempt, with no validity filter. “—” means a timing was not captured, not zero. Scroll horizontally for all sectors and provenance.</p>
          <div className="overflow-x-auto" role="region" aria-label={`${driver.name || "Participant"} complete lap history`} tabIndex={0}>
            <table className="w-full min-w-[900px] text-sm">
              <caption className="sr-only">All recorded lap attempts for {driver.name || `car slot ${driver.carIndex + 1}`}. Sector values are seconds.</caption>
              <thead className="bg-app-surface-alt text-xs text-app-text-muted">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left">Lap / attempt</th>
                  <th scope="col" className="px-3 py-2 text-right">Lap time</th>
                  <th scope="col" className="px-3 py-2 text-right">S1 (s)</th>
                  <th scope="col" className="px-3 py-2 text-right">S2 (s)</th>
                  <th scope="col" className="px-3 py-2 text-right">S3 (s)</th>
                  <th scope="col" className="px-3 py-2 text-left">Validity</th>
                  <th scope="col" className="px-3 py-2 text-left">Completion / context</th>
                  <th scope="col" className="px-3 py-2 text-left">Source / recorded at</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-app-border">
                {driver.laps.map((lap) => (
                  <tr key={lap.id}>
                    <th scope="row" className="whitespace-nowrap px-3 py-3 text-left font-normal">Lap {lap.lapNumber}<span className="mt-1 block text-xs text-app-text-muted">Attempt {lap.attempt}</span></th>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">{formatLapTime(lap.lapTimeSec)}{!lap.completed && lap.lapTimeSec !== null && <span className="block font-sans text-xs text-app-text-muted">partial</span>}</td>
                    <SectorTimes sectors={lap.sectorsSec} />
                    <td className="px-3 py-3"><Validity valid={lap.valid} /></td>
                    <td className="px-3 py-3"><span className="block">{lap.completed ? "Completed" : "Incomplete"}</span><span className="mt-1 block text-xs capitalize text-app-text-muted">{formatLabel(lap.status)}</span></td>
                    <td className="px-3 py-3 text-xs text-app-text-muted"><span className="block break-words">{formatLabel(lap.source)}</span><time dateTime={lap.recordedAt} className="mt-1 block">{formatTimestamp(lap.recordedAt)}</time></td>
                  </tr>
                ))}
                {driver.currentLap && (
                  <tr className="bg-app-accent/5">
                    <th scope="row" className="px-3 py-3 text-left font-normal">{driver.currentLap.lapNumber !== null ? `Lap ${driver.currentLap.lapNumber}` : "Lap unknown"}<span className="mt-1 block text-xs text-app-accent">Current snapshot</span></th>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">{formatLapTime(driver.currentLap.lapTimeSec)}<span className="block font-sans text-xs text-app-text-muted">elapsed</span></td>
                    <SectorTimes sectors={driver.currentLap.sectorsSec} />
                    <td className="px-3 py-3"><Validity valid={driver.currentLap.valid} /></td>
                    <td className="px-3 py-3 text-xs text-app-text-muted">In progress / last observed<br />Not a completed attempt</td>
                    <td className="px-3 py-3 text-xs text-app-text-muted">Live lap data</td>
                  </tr>
                )}
                {driver.laps.length === 0 && !driver.currentLap && <tr><td colSpan={8} className="px-4 py-6 text-app-text-muted">Participant observed; no lap timing received yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </article>
  );
}
