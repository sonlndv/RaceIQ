import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { DriverSessionReview } from "./DriverSessionReview";
import { formatLabel, formatTimestamp, useSandboxSession, useSandboxSessions } from "./session-data";

const actionClass = "rounded-md border border-app-border px-3 py-2 text-sm text-app-text hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-app-accent disabled:opacity-50";

function CaptureInstructions() {
  return (
    <div className="space-y-3 text-sm text-app-text-secondary">
      <p>Tonight on Xbox: open <strong className="text-app-text">F1 25 → Settings → Telemetry Settings</strong> and use the existing RaceIQ destination. No new Sandbox settings are needed.</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-app-border bg-app-surface-alt/30 p-4">
        <dt>UDP Telemetry</dt><dd className="font-semibold text-app-text">On</dd>
        <dt>UDP IP Address</dt><dd className="font-mono text-app-text">192.168.1.32</dd>
        <dt>UDP Port</dt><dd className="font-mono text-app-text">5301</dd>
        <dt>UDP Format</dt><dd className="font-mono text-app-text">2025</dd>
      </dl>
      <p>Keep the Xbox and this RaceIQ receiver on the same reachable network, then drive an Australia / Melbourne session. This page discovers received sessions automatically; the backend captures history even when this page is closed.</p>
      <p>The game's Session History packets supply each observed driver's historical lap and sector timings. Live lap packets add current progress and observed pit, caution, invalid and interrupted attempts. Restricted telemetry or missed packets can leave gaps; missing timings are never invented.</p>
      <p>This review keeps its own received session history. Your normal Home dashboard, existing recordings and recording settings stay unchanged. It does not start or stop a recording. Sessions from before capture was available appear only if genuine captured packet data was imported; opening this page cannot recover packets that were never recorded.</p>
    </div>
  );
}

/** Read-only Australia review, independent of the normal Home dashboard and its data hooks. */
export function SandboxPage() {
  const sessionsQuery = useSandboxSessions();
  const [chosenSessionId, setChosenSessionId] = useState("");
  const [expandedDrivers, setExpandedDrivers] = useState<Set<string>>(() => new Set());
  const sessions = useMemo(
    () => (sessionsQuery.data?.sessions ?? []).filter((session) => session.trackId === 0).sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    [sessionsQuery.data],
  );
  const selectedSessionId = sessions.find((session) => session.id === chosenSessionId)?.id ?? sessions[0]?.id ?? null;
  const detailQuery = useSandboxSession(selectedSessionId);
  const detail = detailQuery.data?.session.id === selectedSessionId && detailQuery.data.session.trackId === 0 ? detailQuery.data : undefined;
  const drivers = useMemo(
    () => detail ? [...detail.drivers].sort((a, b) => Number(b.isPlayer) - Number(a.isPlayer) || a.carIndex - b.carIndex) : [],
    [detail],
  );
  const recordedAttempts = drivers.reduce((total, driver) => total + driver.laps.length, 0);
  const completedAttempts = drivers.reduce((total, driver) => total + driver.laps.filter((lap) => lap.completed).length, 0);
  const allExpanded = drivers.length > 0 && drivers.every((driver) => expandedDrivers.has(`${selectedSessionId}:${driver.carIndex}`));
  const refreshing = sessionsQuery.isFetching || detailQuery.isFetching;
  const packetTime = detail?.coverage.lastPacketAt ? new Date(detail.coverage.lastPacketAt).getTime() : NaN;
  const recentPackets = Number.isFinite(packetTime) && Date.now() - packetTime < 15_000;

  function refresh() {
    void sessionsQuery.refetch();
    if (selectedSessionId !== null) void detailQuery.refetch();
  }

  function toggleDriver(carIndex: number) {
    const key = `${selectedSessionId}:${carIndex}`;
    setExpandedDrivers((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAllDrivers() {
    setExpandedDrivers((previous) => {
      const next = new Set(previous);
      for (const driver of drivers) {
        const key = `${selectedSessionId}:${driver.carIndex}`;
        if (allExpanded) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  }

  return (
    <section data-f1-sandbox className="min-h-full min-w-0 bg-app-bg text-sm text-app-text">
      <div className="mx-auto max-w-[1400px] space-y-5 px-3 py-5 sm:px-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-app-accent">F1 2025 · Sandbox</p>
            <h1 className="mt-1 text-2xl font-semibold">Australia session review</h1>
            <p className="mt-2 max-w-3xl text-app-text-muted">Every observed driver's lap attempts and sectors, including invalid, incomplete, pit, caution and flashback laps. Clean pace is shown separately.</p>
          </div>
          <button type="button" className={`${actionClass} flex items-center gap-2`} onClick={refresh} disabled={refreshing} aria-label="Refresh Australia sessions">
            <RefreshCw size={15} aria-hidden="true" className={refreshing ? "animate-spin" : ""} />
            Refresh
          </button>
        </header>

        <p className="text-xs text-app-text-muted" role="status">
          {sessionsQuery.fetchStatus === "paused" || detailQuery.fetchStatus === "paused" ? "Connection offline · automatic updates resume on reconnect." : "Automatic updates every 2 seconds while this page is visible · refreshes on return."}
        </p>
        {sessionsQuery.isError && <p role="alert" className="rounded-lg border border-app-border p-4">Session list: {sessionsQuery.error instanceof Error ? sessionsQuery.error.message : "Unable to load Australia sessions."} {sessionsQuery.data && "Showing the last received list; automatic refresh will retry."}</p>}
        {sessionsQuery.isPending && <p role="status" className="rounded-lg border border-app-border p-6 text-app-text-muted">Loading recorded Australia sessions…</p>}

        {sessions.length === 0 && !sessionsQuery.isPending && !sessionsQuery.isError && (
          <section className="space-y-4 rounded-lg border border-app-border p-4 sm:p-6">
            <h2 className="text-lg font-semibold">No Australia sessions received yet</h2>
            <p className="text-app-text-muted">Nothing has been fabricated or copied from another track. Your session and actual participants will appear here as Australia packets arrive.</p>
            <CaptureInstructions />
          </section>
        )}

        {sessions.length > 0 && (
          <>
            <div className="rounded-lg border border-app-border p-4">
              <label htmlFor="sandbox-australia-session" className="mb-2 block font-semibold">Session history</label>
              <select id="sandbox-australia-session" value={chosenSessionId && sessions.some((session) => session.id === chosenSessionId) ? chosenSessionId : ""} onChange={(event) => setChosenSessionId(event.target.value)} className="w-full min-w-0 rounded-md border border-app-border bg-app-bg px-3 py-3 text-app-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-app-accent">
                <option value="">Follow newest Australia session automatically</option>
                {sessions.map((session) => <option key={session.id} value={session.id}>{formatTimestamp(session.startedAt)} · {formatLabel(session.sessionType)} · {session.driverCount} drivers · {session.lapCount} recorded attempts{session.closed ? " · Closed" : ""}</option>)}
              </select>
              <p className="mt-2 text-xs text-app-text-muted">Select an earlier session to keep reviewing it while new sessions arrive. Restarts and repeated lap attempts remain separate.</p>
            </div>

            {detailQuery.isError && <p role="alert" className="rounded-lg border border-app-border p-4">Session detail: {detailQuery.error instanceof Error ? detailQuery.error.message : "Unable to load Australia session detail."} {detail && "Showing the last received detail; timings may be stale."}</p>}
            {detailQuery.isPending && <p role="status" className="p-4 text-app-text-muted">Loading every driver's recorded lap history…</p>}

            {detail && (
              <>
                <section className="space-y-4 rounded-lg border border-app-border p-4 sm:p-5" aria-label="Session coverage">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-semibold">{detail.session.trackName} · {formatLabel(detail.session.sessionType)}</h2>
                      <p className="mt-1 text-xs text-app-text-muted">Started {formatTimestamp(detail.session.startedAt)} · Saved update {formatTimestamp(detail.session.updatedAt)}</p>
                    </div>
                    <span className={`rounded-full border border-app-border px-3 py-1 text-xs ${recentPackets && !detail.session.closed ? "text-app-accent" : "text-app-text-muted"}`}>{detail.session.closed ? "Closed session" : recentPackets ? "Receiving packets" : "No recent packets"}</span>
                  </div>
                  <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                    <div><dt className="text-xs text-app-text-muted">Actual drivers observed</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{drivers.length}</dd></div>
                    <div><dt className="text-xs text-app-text-muted">All recorded attempts</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{recordedAttempts}</dd></div>
                    <div><dt className="text-xs text-app-text-muted">Completed attempts</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{completedAttempts}</dd></div>
                    <div><dt className="text-xs text-app-text-muted">Incomplete attempts</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{recordedAttempts - completedAttempts}</dd></div>
                  </dl>
                  <div className="space-y-2 border-t border-app-border pt-3 text-xs text-app-text-secondary">
                    <p><strong>{detail.coverage.missingData ? "Coverage gaps reported: " : "Capture coverage: "}</strong>{detail.coverage.message}</p>
                    <p>{detail.coverage.packetCount.toLocaleString()} packets observed · Last packet {formatTimestamp(detail.coverage.lastPacketAt)}</p>
                    <p>Up to 22 actual participant slots are supported. Unobserved drivers and missing laps are not invented. Snapshot-only history can contain valid times without enough context to count as clean pace.</p>
                  </div>
                </section>

                <section className="space-y-3" aria-labelledby="sandbox-drivers-heading">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 id="sandbox-drivers-heading" className="text-lg font-semibold">All {drivers.length} observed drivers</h2>
                    <button type="button" onClick={toggleAllDrivers} disabled={drivers.length === 0} className={actionClass}>{allExpanded ? "Collapse all lap histories" : "Expand all lap histories"}</button>
                  </div>
                  <p className="text-xs text-app-text-muted">Open any driver to see every recorded lap and attempt, plus the last observed current lap. Clean pace uses only completed, valid, uninterrupted live-observed clean laps; pit, caution, flashback and snapshot-only laps are excluded from pace, never from history.</p>
                  {drivers.length === 0 && <p className="rounded-lg border border-app-border p-5 text-app-text-muted">Session received; waiting for actual participant packets. No placeholder drivers are added.</p>}
                  {drivers.map((driver) => <DriverSessionReview key={`${selectedSessionId}:${driver.carIndex}`} driver={driver} expanded={expandedDrivers.has(`${selectedSessionId}:${driver.carIndex}`)} onToggle={() => toggleDriver(driver.carIndex)} />)}
                </section>
              </>
            )}

            <details className="rounded-lg border border-app-border p-4">
              <summary className="cursor-pointer font-semibold">Xbox capture instructions · existing setup unchanged</summary>
              <div className="pt-4"><CaptureInstructions /></div>
            </details>
          </>
        )}
      </div>
    </section>
  );
}
