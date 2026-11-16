import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Sectors } from "./wire";

export interface SandboxLap {
  id: string; lapNumber: number; attempt: number; lapTimeSec: number | null; sectorsSec: Sectors;
  valid: boolean | null; status: string; source: string; completed: boolean; recordedAt: string;
  sectorValid?: [boolean, boolean, boolean];
  epoch: number;
}
export interface CurrentLap {
  lapNumber: number | null; lapTimeSec: number | null; sectorsSec: Sectors; valid: boolean | null;
}
export interface LiveAttempt extends CurrentLap { lapNumber: number; pit: boolean; caution: boolean; full: boolean; epoch: number; }
export interface SandboxDriver {
  carIndex: number; name: string; teamId: number | null; isPlayer: boolean; telemetryRestricted: boolean; flagCaution: boolean;
  laps: SandboxLap[]; currentLap: LiveAttempt | null; epoch: number; history: Record<string, string>;
}
export interface SandboxSummary {
  id: string; trackId: number; trackName: string; sessionType: string; startedAt: string; updatedAt: string;
  driverCount: number; lapCount: number; playerCarIndex: number | null; closed: boolean;
}
export interface SessionState {
  session: SandboxSummary; uid: string; namespace: string; generation: number; caution: boolean;
  drivers: SandboxDriver[];
  lastPacketAt: string | null; packetCount: number; missingData: boolean;
  sessionTime: number; overallFrame: number; seenFrames: Record<string, number>; epoch: number;
}

/** Additive sidecar only. One coalesced checkpoint replaces previous state; no raw packet log. */
export class SandboxF1Store {
  private readonly db: Database;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS sandbox_f1_sessions (
      id TEXT PRIMARY KEY, namespace TEXT NOT NULL, uid TEXT NOT NULL, generation INTEGER NOT NULL,
      updated_at TEXT NOT NULL, summary TEXT NOT NULL, state TEXT NOT NULL,
      UNIQUE(namespace, uid, generation)
    ); CREATE TABLE IF NOT EXISTS sandbox_f1_imports (source_id TEXT PRIMARY KEY, completed INTEGER NOT NULL DEFAULT 0);`);
  }
  save(state: SessionState): void {
    const s = state.session;
    s.driverCount = state.drivers.length;
    s.lapCount = state.drivers.reduce((n, d) => n + d.laps.length, 0);
    this.db.query(`INSERT INTO sandbox_f1_sessions VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, summary=excluded.summary, state=excluded.state`)
      .run(s.id, state.namespace, state.uid, state.generation, s.updatedAt, JSON.stringify(s), JSON.stringify(state));
  }
  list(): SandboxSummary[] {
    return (this.db.query("SELECT summary FROM sandbox_f1_sessions ORDER BY updated_at DESC, id").all() as Array<{ summary: string }>).map((r) => JSON.parse(r.summary));
  }
  get(id: string): SessionState | null {
    const row = this.db.query("SELECT state FROM sandbox_f1_sessions WHERE id = ?").get(id) as { state: string } | null;
    return row ? JSON.parse(row.state) : null;
  }
  states(namespace: string, openOnly = false): SessionState[] {
    const sql = openOnly
      ? "SELECT state FROM sandbox_f1_sessions WHERE namespace = ? AND json_extract(summary, '$.closed') = 0 ORDER BY updated_at"
      : "SELECT state FROM sandbox_f1_sessions WHERE namespace = ? ORDER BY updated_at";
    return (this.db.query(sql).all(namespace) as Array<{ state: string }>).map((r) => JSON.parse(r.state));
  }
  nextGeneration(namespace: string, uid: string): number {
    const row = this.db.query("SELECT MAX(generation) AS generation FROM sandbox_f1_sessions WHERE namespace = ? AND uid = ?").get(namespace, uid) as { generation: number | null };
    return (row.generation ?? -1) + 1;
  }
  importStatus(sourceId: string): "complete" | "incomplete" | null {
    const row = this.db.query("SELECT completed FROM sandbox_f1_imports WHERE source_id = ?").get(sourceId) as { completed: number } | null;
    return row ? row.completed ? "complete" : "incomplete" : null;
  }
  startImport(sourceId: string): void { this.db.query("INSERT INTO sandbox_f1_imports(source_id) VALUES (?)").run(sourceId); }
  finishImport(sourceId: string): void { this.db.query("UPDATE sandbox_f1_imports SET completed=1 WHERE source_id=?").run(sourceId); }
  close(): void { this.db.close(); }
}

export function sessionDetail(state: SessionState) {
  return {
    session: state.session,
    drivers: state.drivers.map(({ carIndex, name, teamId, isPlayer, telemetryRestricted, laps, currentLap }) => ({
      carIndex, name, teamId, isPlayer, telemetryRestricted, laps: laps.map(({ epoch: _epoch, ...lap }) => lap),
      currentLap: currentLap ? { lapNumber: currentLap.lapNumber, lapTimeSec: currentLap.lapTimeSec, sectorsSec: currentLap.sectorsSec, valid: currentLap.valid } : null,
    })),
    coverage: {
      message: "Only observed F1 25 UDP data is available. Missing packets, unavailable telemetry and pre-capture laps cannot be reconstructed. History-only laps have unknown pit/caution context; incomplete and flashback attempts are retained.",
      lastPacketAt: state.lastPacketAt, packetCount: state.packetCount, missingData: state.missingData,
    },
  };
}
