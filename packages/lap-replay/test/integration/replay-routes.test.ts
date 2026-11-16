import { describe, expect, test } from "bun:test";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { getGame } from "@raceiq/shared/games/registry";
import { analyseSemanticIds } from "@raceiq/shared/games/metric-contracts";
import { deleteSession, insertSession } from "@raceiq/backend-core/db/session-queries";
import { cacheDelete, cacheSet } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { insertLap } from "@raceiq/backend-core/db/lap-mutation-queries";
import { packet } from "@raceiq/telemetry-core/test-support/telemetry/resolver";
import { replayRoutes, semanticReplayIds } from "../../server";
import type { SemanticLapTelemetry } from "../../contracts/replay";
import type { KunosExtendedData } from "@raceiq/shared/telemetry/kunos";

import { decodeSemanticLapTelemetry, SEMANTIC_REPLAY_MEDIA_TYPE } from "../../contracts/replay-wire";
initGameAdapters();
test("semantic replay requests F1 Analyse dependencies", () => {
  const ids = semanticReplayIds("f1-2025");
  expect(ids).toEqual(analyseSemanticIds(getGame("f1-2025")));
  expect(ids).toContain("timing.current-lap");
  expect(ids).toContain("timing.lap-fraction");
  expect(ids).toContain("tire.temperature.surface.representative");
  expect(ids).toContain("tire.temperature.surface.inner");
  expect(ids).toContain("tire.temperature.surface.middle");
  expect(ids).toContain("tire.temperature.surface.outer");
  expect(ids).toContain("tire.temperature.core");
  expect(ids).not.toContain("tires.wheel-in-puddle-depth");
});

describe("GET /api/laps/:id/semantic-telemetry", () => {
  test("returns full F1 Analyse replay with adapter channels", async () => {
    const sessionId = await insertSession("0", "0", "f1-2025");
    const lapId = await insertLap(sessionId, 1, 80.9, true, null, 0, null, null, null, null, null);
    cacheSet(lapId, [
      packet("f1-2025", { TimestampMS: 1_000, Speed: 10 }),
      packet("f1-2025", { TimestampMS: 1_017, Speed: 20 }),
    ]);
    try {
      const response = await replayRoutes.request(`/api/laps/${lapId}/semantic-telemetry`, {
        headers: { "X-Game-Id": "f1-2025" },
      });

      expect(response.status).toBe(200);
      const body = await response.json() as {
        lapId: number;
        requestedSemanticIds: readonly string[];
        envelopes: { sequence: number; values: { semanticId: string }[] }[];
        parseError: string | null;
      };
      expect(body.lapId).toBe(lapId);
      expect(body.parseError).toBeNull();
      expect(body.requestedSemanticIds).toEqual(analyseSemanticIds(getGame("f1-2025")));
      expect(body.envelopes).toHaveLength(2);
      expect(body.envelopes.map((envelope) => envelope.sequence)).toEqual([0, 1]);
      expect(body.envelopes[0]?.values).toEqual(
        expect.arrayContaining([expect.objectContaining({ semanticId: "motion.speed", value: 10 })]),
      );
      expect(body.envelopes[1]?.values).toEqual(
        expect.arrayContaining([expect.objectContaining({ semanticId: "motion.speed", value: 20 })]),
      );
    } finally {
      cacheDelete(lapId);
      await deleteSession(sessionId);
    }
  });
  test.each([true, false])("preserves AC Evo native TC intervention=%s evidence", async (active) => {
    const sessionId = await insertSession("0", "0", "ac-evo");
    const lapId = await insertLap(sessionId, 1, 80.9, true, null, 0, null, null, null, null, null);
    cacheSet(lapId, Array.from({ length: 32 }, (_, index) => packet("ac-evo", {
      TimestampMS: index * 20,
      CurrentRaceTime: index * 0.02,
      acc: { tcIntervention: active && index < 4 ? 1 : 0, absIntervention: 0 } as KunosExtendedData,
    })));
    try {
      const response = await replayRoutes.request(`/api/laps/${lapId}/semantic-telemetry`, { headers: { "X-Game-Id": "ac-evo" } });
      expect(response.status).toBe(200);
      const body = await response.json() as SemanticLapTelemetry;
      const tc = body.insights.find((insight) => insight.id === "driving-traction-control-activation");
      if (active) {
        expect(tc?.evidenceSource).toBe("native");
        expect(tc?.label).toBe("Traction Control Activation");
        expect(tc?.detail).toContain("0.08s active");
      } else {
        expect(tc).toBeUndefined();
        expect(body.detectorCoverage.find((detector) => detector.id === "driving-traction-control-activation")?.status).toBe("checked");
      }
    } finally {
      cacheDelete(lapId);
      await deleteSession(sessionId);
    }
  });
  test.each([false, true])("keeps invalid rewound attempts replayable with semantic evidence (compact=%s)", async compact => {
    const sessionId = await insertSession("0", "17", "f1-2025");
    const lapId = await insertLap(sessionId, 37, 80, false, null, 0, null, null, "rewind", null, null);
    cacheSet(lapId, [0, 0.05, 0.1, 0.02, 0.07].map((CurrentLap, index) => packet("f1-2025", { TimestampMS: index * 50, CurrentLap, PositionX: index * 2, PositionZ: 5 })));
    try {
      const response = await replayRoutes.request(`/api/laps/${lapId}/semantic-telemetry`, { headers: { "X-Game-Id": "f1-2025", ...(compact ? { Accept: SEMANTIC_REPLAY_MEDIA_TYPE } : {}) } });
      expect(response.status).toBe(200);
      const body = decodeSemanticLapTelemetry(await response.json());
      expect(body.envelopes).toHaveLength(5);
      expect(body.evidence!.raceiqValidation).toMatchObject({ state: "invalid", reason: "rewind" });
      expect(body.evidence!.recording.state).toBe("partial");
      expect(body.evidence!.cleanPace.state).toBe("ineligible");
      expect(body.evidence!.runs.map(run => [run.startFrame, run.endFrame])).toEqual([[0, 2], [3, 4]]);
    } finally { cacheDelete(lapId); await deleteSession(sessionId); }
  });
});
