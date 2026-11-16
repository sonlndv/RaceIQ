import { F1_SESSION_TYPES } from "@raceiq/capture-formats/f1-2025/f1-wire";
import { decodeSandboxWire, type HistoryLap, type LapSample, type WirePacket } from "./wire";
import { SandboxF1Store, type SandboxDriver, type SandboxLap, type SessionState } from "./store";

const isAustriaRace = (packet: Extract<WirePacket, { kind: "session" }>) => packet.trackId === 17 && packet.sessionType >= 15 && packet.sessionType <= 17;

// History sectors are truncated independently; a derived S3 can differ by 1–2 ms.
const sameTiming = (a: number | null, b: number | null) => a === null || b === null || Math.abs(a - b) <= 0.0025;

/** Independent of player parser readiness, recorder ownership and WebSocket state. */
export class SandboxF1Observer {
  private active: SessionState | null = null;
  private urgent = false;
  private dirty = false;
  private lastFlush = 0;
  private readonly namespace: string;
  private pending: WirePacket[] = [];
  private pendingUid: string | null = null;
  private retiredUids = new Set<string>();
  readonly store: SandboxF1Store;

  constructor(store: SandboxF1Store, options: { namespace?: string } = {}) {
    this.store = store;
    this.namespace = options.namespace ?? "live";
    // A process gap cannot certify continuity. Close checkpoints, preserving partials,
    // then allocate another generation if this game UID reappears after restart.
    for (const state of store.states(this.namespace, true)) {
      this.active = state;
      this.finish("interrupted", state.lastPacketAt ?? state.session.updatedAt);
    }
  }

  ingestWire(frame: Buffer, receivedAtMs: number): boolean {
    if (!Number.isFinite(receivedAtMs)) throw new Error("Sandbox ingestion requires a real capture timestamp");
    const packet = decodeSandboxWire(frame);
    if (!packet) return false;
    const uid = packet.header.sessionUID.toString();
    const at = new Date(receivedAtMs).toISOString();
    // UID0 auxiliary/history packets do not identify a race or replace its preamble.
    // A retirement can enrich a known driver's existing context, even after SEND.
    if (uid === "0") {
      if (!this.active || packet.kind !== "event" || packet.code !== "RTMT" || frame.length < 34
        || packet.header.playerCarIndex !== this.active.session.playerCarIndex
        || !this.active.drivers.some((driver) => driver.carIndex === frame[33])) return false;
      this.retire(frame[33]!, at);
      this.active.packetCount++;
      this.active.lastPacketAt = at;
      this.active.session.updatedAt = at;
      this.dirty = true;
      this.flush(receivedAtMs);
      return true;
    }
    // Do not attribute metadata before the first Session packet to another track.
    // Bounded preamble retains participants/history when capture order starts there.
    if (!this.active || this.active.uid !== uid) {
      if (this.retiredUids.has(uid)) return false;
      if (packet.kind !== "session") {
        if (this.pendingUid !== uid) { this.pending = []; this.pendingUid = uid; }
        if (packet.kind === "participants" || packet.kind === "history" || packet.kind === "laps" || packet.kind === "flags") {
          this.pending = this.pending.filter((p) => !(p.kind === packet.kind && (p.kind !== "history" || packet.kind !== "history" || p.carIndex === packet.carIndex)));
          this.pending.push(packet);
        }
        return false;
      }
      if (this.active) {
        this.retiredUids.add(this.active.uid);
        if (this.retiredUids.size > 32) this.retiredUids.delete(this.retiredUids.values().next().value!);
        this.finish("reset", at);
      }
      if (!isAustriaRace(packet)) { this.pending = []; this.pendingUid = null; return false; }
      this.start(packet, at);
      const preamble = this.pendingUid === uid ? this.pending : [];
      this.pending = []; this.pendingUid = null;
      for (const p of preamble) { this.apply(p, at); this.active!.packetCount++; }
    }
    let state = this.active!;
    const h = packet.header;
    if (packet.kind === "event" && packet.code === "SSTA" && (state.session.closed || state.drivers.some((d) => d.laps.length > 0 || d.currentLap !== null && d.currentLap.lapTimeSec !== null))) {
      const sessionType = Number(Object.entries(F1_SESSION_TYPES).find(([, name]) => name === state.session.sessionType)?.[0] ?? 0);
      const caution = state.caution;
      this.finish("reset", at);
      this.start({ header: h, kind: "session", trackId: 17, sessionType, caution }, at);
      state = this.active!;
    }
    // overallFrameIdentifier is not rewound by FLBK, unlike frameIdentifier.
    // Require both counters/time to reset substantially before creating a generation.
    if (packet.kind === "session" && h.overallFrameIdentifier < state.overallFrame && h.sessionTime + 2 < state.sessionTime) {
      this.finish("reset", at);
      if (!isAustriaRace(packet)) return false;
      this.start(packet, at);
      state = this.active!;
    }
    if (packet.kind === "session" && !isAustriaRace(packet)) { this.finish("reset", at); return false; }
    // Different events (e.g. SEND and RTMT) can share an overall frame.
    const eventCar = packet.kind === "event" ? packet.code === "PENA" ? frame[35] : packet.code === "RTMT" || packet.code === "COLL" || packet.code === "OVTK" ? frame[33] : "" : "";
    const key = packet.kind === "history" ? `history:${packet.carIndex}` : packet.kind === "event" ? `event:${packet.code}:${eventCar}` : String(h.packetId);
    const lastFrame = state.seenFrames[key];
    if (lastFrame !== undefined && h.overallFrameIdentifier <= lastFrame) return false;
    state.seenFrames[key] = h.overallFrameIdentifier;
    state.overallFrame = Math.max(state.overallFrame, h.overallFrameIdentifier);
    state.sessionTime = h.sessionTime;
    state.packetCount++;
    state.lastPacketAt = at;
    state.session.updatedAt = at;
    state.session.playerCarIndex = h.playerCarIndex < 22 ? h.playerCarIndex : null;
    for (const d of state.drivers) d.isPlayer = d.carIndex === state.session.playerCarIndex;
    if (packet.kind === "event" && packet.code === "RTMT" && frame.length >= 34 && frame[33]! < 22) this.retire(frame[33]!, at);
    this.apply(packet, at);
    this.dirty = true;
    if (this.urgent || receivedAtMs - this.lastFlush >= 1000 || packet.kind === "participants" || packet.kind === "event") this.flush(receivedAtMs);
    return true;
  }

  private start(packet: Extract<WirePacket, { kind: "session" }>, at: string): void {
    const uid = packet.header.sessionUID.toString();
    const generation = this.store.nextGeneration(this.namespace, uid);
    this.active = {
      session: { id: `f1:${this.namespace}:${uid}:${generation}`, trackId: 17, trackName: "Austria / Red Bull Ring", sessionType: F1_SESSION_TYPES[packet.sessionType] ?? "unknown", startedAt: at, updatedAt: at, driverCount: 0, lapCount: 0, playerCarIndex: packet.header.playerCarIndex < 22 ? packet.header.playerCarIndex : null, closed: false },
      uid, generation, namespace: this.namespace, caution: packet.caution, drivers: [],
      lastPacketAt: at, packetCount: 0, missingData: true, sessionTime: packet.header.sessionTime, overallFrame: packet.header.overallFrameIdentifier, seenFrames: {}, epoch: 0,
    };
    this.dirty = true;
  }

  private apply(packet: WirePacket, at: string): void {
    const state = this.active!;
    switch (packet.kind) {
      case "session":
        state.caution = packet.caution;
        if (packet.caution) for (const d of state.drivers) if (d.currentLap) d.currentLap.caution = true;
        state.session.sessionType = F1_SESSION_TYPES[packet.sessionType] ?? "unknown";
        break;
      case "participants":
        for (const p of packet.drivers) {
          const driver = this.driver(p.carIndex);
          driver.name = p.name; driver.teamId = p.teamId; driver.telemetryRestricted = p.restricted;
        }
        state.drivers.sort((a, b) => a.carIndex - b.carIndex);
        break;
      case "laps":
        if (state.session.closed) break;
        for (const sample of packet.cars) {
          if (sample.active && sample.lapNumber > 0) this.lap(this.driver(sample.carIndex), sample, at);
        }
        break;
      case "history":
        if (packet.laps.some((l) => l.time !== null || l.sectors.some((s) => s !== null))) this.history(this.driver(packet.carIndex), packet.laps, at);
        break;
      case "flags":
        for (const d of state.drivers) {
          d.flagCaution = packet.caution[d.carIndex]!;
          if (d.currentLap && d.flagCaution) d.currentLap.caution = true;
        }
        break;
      case "event":
        if (packet.code === "FLBK") {
          state.epoch++;
          for (const d of state.drivers) { this.closeAttempt(d, "flashback", at); d.epoch = state.epoch; }
        } else if (packet.code === "SEND") {
          for (const d of state.drivers) this.closeAttempt(d, "incomplete", at);
          state.session.closed = true;
        }
        break;
    }
  }

  private driver(carIndex: number): SandboxDriver {
    const state = this.active!;
    let driver = state.drivers.find((d) => d.carIndex === carIndex);
    if (!driver) {
      // A history entry or active LapData slot is evidence of a real car even
      // when Participants was lost. Unknown names stay empty, never fabricated.
      driver = { carIndex, name: "", teamId: null, telemetryRestricted: true, flagCaution: false, isPlayer: carIndex === state.session.playerCarIndex, laps: [], currentLap: null, epoch: state.epoch, history: {} };
      state.drivers.push(driver);
      state.drivers.sort((a, b) => a.carIndex - b.carIndex);
    }
    return driver;
  }

  private append(driver: SandboxDriver, lap: Omit<SandboxLap, "id" | "attempt">): SandboxLap {
    const attempt = driver.laps.reduce((n, l) => l.lapNumber === lap.lapNumber ? Math.max(n, l.attempt) : n, 0) + 1;
    const result = { ...lap, attempt, id: `${this.active!.session.id}:${driver.carIndex}:${lap.lapNumber}:${attempt}` };
    driver.laps.push(result);
    this.urgent = true;
    return result;
  }

  private retire(carIndex: number, at: string): void {
    const driver = this.driver(carIndex);
    if (driver.currentLap) this.closeAttempt(driver, "retired", at);
    else {
      const last = driver.laps.at(-1);
      if (last && !last.completed && last.status === "incomplete") {
        last.status = "retired";
        last.recordedAt = at;
      }
    }
  }

  private closeAttempt(driver: SandboxDriver, status: string, at: string): void {
    const current = driver.currentLap;
    if (!current) return;
    // A garage lap with no timing, invalidation or sectors is not an observed attempt.
    if (current.lapTimeSec !== null || current.sectorsSec.some((s) => s !== null) || current.valid === false) {
      const existing = driver.laps.findLast((lap) => lap.epoch === current.epoch && lap.lapNumber === current.lapNumber && !lap.completed && lap.source === "session-history");
      if (existing) {
        existing.lapTimeSec = current.lapTimeSec;
        existing.valid = existing.valid === false || current.valid === false ? false : current.valid;
        existing.status = status;
        existing.source = "lap-data+session-history";
        existing.recordedAt = at;
        for (let i = 0; i < 3; i++) if (current.sectorsSec[i] !== null) existing.sectorsSec[i] = current.sectorsSec[i]!;
        this.urgent = true;
      } else this.append(driver, { lapNumber: current.lapNumber, lapTimeSec: current.lapTimeSec, sectorsSec: current.sectorsSec, valid: current.valid, status, source: "lap-data", completed: false, recordedAt: at, epoch: current.epoch });
    }
    driver.currentLap = null;
  }

  private lap(driver: SandboxDriver, sample: LapSample, at: string): void {
    if (sample.lapNumber === 0 || !sample.active) return;
    let current = driver.currentLap;
    if (sample.invalid && current?.valid !== false) this.urgent = true;
    let full = false;
    if (current && (sample.lapNumber < current.lapNumber || (sample.lapNumber === current.lapNumber && current.lapTimeSec !== null && (sample.time ?? 0) + 2 < current.lapTimeSec))) {
      this.closeAttempt(driver, "flashback", at);
      driver.epoch = ++this.active!.epoch;
      current = null;
    }
    if (current && sample.lapNumber > current.lapNumber) {
      const completed = sample.lapNumber === current.lapNumber + 1 && sample.lastTime !== null;
      if (completed) {
        const time = sample.lastTime!;
        const sectors = [...current.sectorsSec] as SandboxLap["sectorsSec"];
        if (sectors[0] !== null && sectors[1] !== null && time > sectors[0] + sectors[1]) sectors[2] = Math.round((time - sectors[0] - sectors[1]) * 1000) / 1000;
        const status = current.valid === false ? "invalid" : current.pit ? "pit" : current.caution ? "caution" : current.full && current.valid === true ? "clean" : "history";
        const existing = driver.laps.findLast((l) => l.epoch === current!.epoch && l.lapNumber === current!.lapNumber && l.source === "session-history" && sameTiming(l.lapTimeSec, time) && l.sectorsSec.every((s, i) => sameTiming(s, sectors[i]!)));
        if (existing) {
          existing.completed = true;
          existing.lapTimeSec = time;
          this.urgent = true;
          existing.valid = existing.valid === false || current.valid === false ? false : current.valid;
          existing.status = existing.valid === false ? "invalid" : status;
          existing.source = "lap-data+session-history";
          for (let i = 0; i < 3; i++) if (existing.sectorsSec[i] === null) existing.sectorsSec[i] = sectors[i]!;
        } else this.append(driver, { lapNumber: current.lapNumber, lapTimeSec: time, sectorsSec: sectors, valid: current.valid, status, source: "lap-data", completed: true, recordedAt: at, epoch: current.epoch });
        driver.currentLap = null;
        full = true;
      } else this.closeAttempt(driver, "incomplete", at);
      current = null;
      this.urgent = true;
    }
    if (!current) {
      current = { lapNumber: sample.lapNumber, lapTimeSec: sample.time, sectorsSec: [...sample.sectors], valid: sample.invalid ? false : sample.time !== null || sample.sectors.some((s) => s !== null) ? true : null, pit: sample.pit, caution: this.active!.caution || driver.flagCaution, full, epoch: driver.epoch };
      driver.currentLap = current;
    } else {
      current.lapTimeSec = sample.time ?? current.lapTimeSec;
      current.valid = current.valid === false || sample.invalid ? false : sample.time !== null || sample.sectors.some((s) => s !== null) ? true : current.valid;
      current.pit ||= sample.pit;
      current.caution ||= this.active!.caution;
      for (let i = 0; i < 2; i++) if (sample.sectors[i] !== null) current.sectorsSec[i] = sample.sectors[i]!;
    }
  }

  private history(driver: SandboxDriver, incoming: HistoryLap[], at: string): void {
    for (const h of incoming) {
      if (h.time === null && h.sectors.every((s) => s === null)) continue;
      const signature = JSON.stringify([h.time, h.sectors, h.flags]);
      const key = `${h.lapNumber}:${signature}`;
      // An unchanged prefix after flashback still describes the earlier attempt.
      // Prefer a newly observed live completion before the deduplication shortcut.
      let lap = driver.laps.findLast((l) => l.lapNumber === h.lapNumber && l.epoch === driver.epoch && l.completed && l.source.startsWith("lap-data") && sameTiming(l.lapTimeSec, h.time) && l.sectorsSec.every((s, i) => sameTiming(s, h.sectors[i]!)));
      lap ??= driver.laps.findLast((l) => l.lapNumber === h.lapNumber && l.epoch === driver.epoch && !l.completed && l.source === "session-history");
      if (!lap && driver.history[key]) continue;
      if (!lap) lap = this.append(driver, { lapNumber: h.lapNumber, lapTimeSec: h.time, sectorsSec: h.sectors, valid: (h.flags & 1) !== 0, status: (h.flags & 1) === 0 ? "invalid" : "history", source: "session-history", completed: h.time !== null, recordedAt: at, epoch: driver.epoch });
      else {
        if (lap.source.startsWith("lap-data")) lap.source = "lap-data+session-history";
        if (h.time !== null) lap.completed = true;
        lap.lapTimeSec = h.time ?? lap.lapTimeSec;
        for (let i = 0; i < 3; i++) if (lap.sectorsSec[i] === null && h.sectors[i] !== null) lap.sectorsSec[i] = h.sectors[i]!;
        // Snapshot validity must not erase an invalidation observed during the attempt.
        lap.valid = lap.valid === false ? false : (h.flags & 1) !== 0;
        if (!lap.valid) lap.status = "invalid";
      }
      lap.sectorValid = [(h.flags & 2) !== 0, (h.flags & 4) !== 0, (h.flags & 8) !== 0];
      driver.history[key] = lap.id;
    }
  }

  flush(now = Date.now()): void {
    if (this.active && this.dirty) { this.store.save(this.active); this.dirty = false; this.urgent = false; this.lastFlush = now; }
  }
  finish(reason = "incomplete", at = new Date().toISOString()): void {
    if (!this.active) return;
    for (const d of this.active.drivers) this.closeAttempt(d, reason, at);
    this.active.session.closed = true;
    this.active.session.updatedAt = at;
    this.dirty = true;
    this.flush();
    this.active = null;
  }
}
