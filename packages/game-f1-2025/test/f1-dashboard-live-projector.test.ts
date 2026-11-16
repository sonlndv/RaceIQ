import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { LiveTelemetryProjector } from "@raceiq/telemetry-core/telemetry/live-projector";
import { trustedNativeExecutor } from "@raceiq/telemetry-core/telemetry/resolver/readers";
import { TELEMETRY_CATALOG } from "@raceiq/shared/telemetry/catalog/data";
import { f1Parser } from "@raceiq/game-f1-2025/game-parser";
import { readUdpDump } from "@raceiq/backend-core/test-support/recordings/udp";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { LiveTelemetrySchemaMessageV1, LiveTelemetryFrameMessageV1 } from "@raceiq/shared/telemetry/live/contracts";
import type { ReaderContext } from "@raceiq/telemetry-core/telemetry/resolver/plan";

const capturePath = fileURLToPath(new URL("../../../test/artifacts/sessions/f1-2025-2026-04-09T21-34-10-190Z.bin.gz", import.meta.url));
let preservedPacket: TelemetryPacket | undefined;
function nativePacket(): TelemetryPacket {
  if (preservedPacket) return structuredClone(preservedPacket);
  const state = f1Parser.createParserState!();
  for (const datagram of readUdpDump(capturePath)) {
    const packet = f1Parser.tryParse(datagram, state);
    const f1 = packet?.f1;
    if (packet && f1 && (f1.trackLength ?? 0) > 0 && f1.sector1Time > 0 && packet.LastLap > 0 &&
        f1.grid.length > 0 && f1.grid.some((driver) => driver.bestLapTime > 0) &&
        f1.grid.every((driver) => [0, 1, 2].includes(driver.pitStatus)) &&
        (f1.currentLapInvalid === 0 || f1.currentLapInvalid === 1)) {
      preservedPacket = structuredClone(packet);
      return structuredClone(preservedPacket);
    }
  }
  throw new Error("Preserved native F1 capture must contain completed lap/grid/sector telemetry");
}
function project(packet: TelemetryPacket) {
  const result = new LiveTelemetryProjector().project({ packet, sessionId: 7, receivedAtMs: 1000 });
  expect(result.schema).toBeDefined();
  expect(result.frame).toBeDefined();
  return { schema: result.schema!, frame: result.frame! };
}
function channel(schema: LiveTelemetrySchemaMessageV1, frame: LiveTelemetryFrameMessageV1, id: string) {
  const index = schema.definitions.findIndex((definition) => definition.semanticId === id);
  expect(index).toBeGreaterThanOrEqual(0);
  return { value: frame.values[index], state: frame.states?.[index], freshness: frame.freshness?.[index], definition: schema.definitions[index] };
}
function resolved(schema: LiveTelemetrySchemaMessageV1, frame: LiveTelemetryFrameMessageV1, id: string, value: unknown, unit: string) {
  const actual = channel(schema, frame, id);
  expect(actual.state).toBeUndefined();
  expect(actual.freshness).toBeUndefined();
  expect(actual.definition.unit).toBe(unit);
  expect(actual.value).toEqual(value);
}

describe("F1 Dashboard 3 native live projection", () => {
  test("preserved UDP capture resolves the actual parser -> resolver -> protocol 1 wire fields", () => {
    const packet = nativePacket();
    const f1 = packet.f1!;
    const { schema, frame } = project(packet);
    resolved(schema, frame, "timing.current-lap-valid", f1.currentLapInvalid === 0, "boolean");
    resolved(schema, frame, "race.competitor.pit-status", f1.grid.map((driver) => driver.pitStatus !== 0), "enum");
    resolved(schema, frame, "timing.competitor.last-lap-time", f1.grid.map((driver) => driver.lastLapTime), "s");
    resolved(schema, frame, "timing.competitor.best-lap-time", f1.grid.map((driver) => driver.bestLapTime), "s");
    resolved(schema, frame, "diagnostics.timestamp-ms", packet.TimestampMS, "ms");
    const ratio = packet.DistanceTraveled / f1.trackLength!;
    resolved(schema, frame, "timing.lap-fraction", Math.max(0, Math.min(1, ratio <= 1 ? ratio : ratio % 1)), "fraction");
    resolved(schema, frame, "timing.sector.current-index", f1.currentSector, "index");
    resolved(schema, frame, "timing.sector.current-lap.s1", f1.sector1Time, "s");
    resolved(schema, frame, "timing.sector.current-lap.s2", f1.sector2Time, "s");
    for (const n of [1, 2, 3] as const) resolved(schema, frame, `timing.sector.last-lap.s${n}`, f1[`lastS${n}`], "s");
    expect(frame.observedAt).toEqual({ domain: "session", milliseconds: packet.TimestampMS });
  }, 120_000);

  test("validity and pit conversion handle every documented numeric code without truthiness", () => {
    for (const invalid of [0, 1]) {
      const packet = nativePacket();
      packet.f1!.currentLapInvalid = invalid;
      packet.f1!.grid.forEach((driver, index) => { driver.pitStatus = index % 3; });
      const { schema, frame } = project(packet);
      resolved(schema, frame, "timing.current-lap-valid", invalid === 0, "boolean");
      resolved(schema, frame, "race.competitor.pit-status", packet.f1!.grid.map((driver) => driver.pitStatus !== 0), "enum");
    }
  });

  test.each([-1, 3, Number.NaN, "0"])("unknown native codes %j are invalid, never falsely clean", (code) => {
    const packet = nativePacket();
    packet.f1!.currentLapInvalid = code as number;
    packet.f1!.grid[0].pitStatus = code as number;
    const { schema, frame } = project(packet);
    for (const id of ["timing.current-lap-valid", "race.competitor.pit-status"]) {
      const actual = channel(schema, frame, id);
      expect(actual.value).toBeNull();
      expect(actual.state).toBe("invalid");
    }
  });

  test("trusted conversions observe raw native sources with original freshness and timestamp provenance", () => {
    const packet = nativePacket();
    const observation = { timestamp: { domain: "session" as const, milliseconds: 1234 }, updateSequence: 9n };
    for (const [id, source, raw] of [
      ["timing.current-lap-valid", "f1.currentLapInvalid", packet.f1!.currentLapInvalid],
      ["race.competitor.pit-status", "f1.grid[].pitStatus", packet.f1!.grid.map((driver) => driver.pitStatus)],
    ] as const) {
      const variable = TELEMETRY_CATALOG.variables.find((entry) => entry.id === id)!;
      const mapping = variable.games["f1-2025"];
      if (mapping.kind === "unavailable") throw new Error(`Required F1 conversion missing: ${id}`);
      const observed: unknown[][] = [];
      const context: ReaderContext = { observe: (...args) => { observed.push(args); return observation; } };
      const executor = trustedNativeExecutor(variable, mapping);
      expect(executor).toBeDefined();
      const reading = executor!(packet as unknown as Record<string, unknown>, context);
      expect(reading?.sourceChannel).toBe(source);
      expect(reading?.observation).toBe(observation);
      expect(observed).toEqual([[source, raw, mapping.freshness]]);
    }
  });
});
