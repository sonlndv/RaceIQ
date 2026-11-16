import { expect, test } from "bun:test";
import * as THREE from "three";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { disposeTireTrailResource, type TireTrailResource } from "@raceiq/scene-3d/wireframe/TireTrails";
import { getWheelOffsets } from "@raceiq/scene-3d/wireframe-utils";
import { SpectateSceneRuntime } from "../../ui/SpectateSceneRuntime"
import type { SpectateReading, SpectateSample } from "../../contracts/spectate"

initGameAdapters({ f1Experiments: true, iracingAdapter: true });
const carModel = { halfWheelbase: 1.5, halfFrontTrack: 0.8, halfRearTrack: 0.8 };

type TrailProbe = { updateTrail(side: 0 | 1, reading: SpectateReading | null): void; trails: [TireTrailResource | null, TireTrailResource | null] };
const sample = (time: number, x: number, run = 0): SpectateSample => ({ time, distance: x, run, values: {
  "motion.position-x": x, "motion.position-y": 0, "motion.position-z": 0, "motion.yaw": Math.PI / 2,
} });
function probe(samples: SpectateSample[], motionSamples?: SpectateSample[]): TrailProbe {
  return Object.assign(Object.create(SpectateSceneRuntime.prototype) as TrailProbe, {
    scene: new THREE.Scene(), origin: new THREE.Vector3(), tireTrails: true,
    trails: [null, null], trailFrames: [[], []],
    pair: { gameId: "f1-2025", a: { samples, motionSamples }, b: { samples, motionSamples } },
    slots: [{ config: { carModel } }],
    trailHeads: [{ values: {}, states: {}, freshness: {} }, { values: {}, states: {}, freshness: {} }],
  });
}
function draw(runtime: TrailProbe, time: number, x: number) {
  runtime.updateTrail(0, { time, distance: x, pose: { x, y: 0, z: 0, yaw: Math.PI / 2 }, values: sample(time, x).values });
  const mesh = runtime.trails[0]!.mesh;
  mesh.updateMatrixWorld(true);
  const matrix = new THREE.Matrix4();
  let head = Infinity;
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, matrix);
    for (const end of [-0.5, 0.5]) {
      head = Math.min(head, new THREE.Vector3(0, 0, end).applyMatrix4(matrix).applyMatrix4(mesh.matrixWorld).x);
    }
  }
  return { head, mesh };
}

test("Spectate tire trails follow interpolated wheels between recorded ticks", () => {
  const samples = [sample(0, 0), sample(0.1, 1), sample(0.2, 2), sample(0.3, 3), sample(0.4, 4)];
  const runtime = probe(samples);
  try {
    for (const time of [0.21, 0.24, 0.29, 0.3, 0.31, 0.35, 0.4, 0.25]) {
      const { head, mesh } = draw(runtime, time, time * 10);
      expect(mesh.visible).toBe(true);
      expect(head).toBeCloseTo(-(time * 10 + 1.5), 5);
    }
    expect(samples.map(frame => frame.values["motion.position-x"])).toEqual([0, 1, 2, 3, 4]);
  } finally { for (const trail of runtime.trails) if (trail) disposeTireTrailResource(trail); }
});

test("Spectate trails use distinct F1 motion history without bridging new runs", () => {
  const motion = [sample(0, 0), sample(0.1, 1), sample(0.3, 3), sample(1.3, 13, 1), sample(1.4, 14, 1)];
  const runtime = probe([motion[0]!, motion[1]!, sample(0.2, 1), ...motion.slice(2)], motion);
  try {
    const { head } = draw(runtime, 0.25, 2.5);
    expect(head).toBeCloseTo(-4, 5);
    expect(draw(runtime, 1.3, 13).mesh.visible).toBe(false);
    expect(draw(runtime, 0.5, 5).mesh.visible).toBe(false);
    runtime.updateTrail(0, null);
    expect(runtime.trails[0]!.mesh.visible).toBe(false);
  } finally { for (const trail of runtime.trails) if (trail) disposeTireTrailResource(trail); }
});

test("reflected trail endpoints meet the same physical wheels at every heading and preserve elevation", () => {
  const wheelOffsets = getWheelOffsets(carModel);
  for (const yaw of [0, Math.PI / 2, -0.9, 2.4]) {
    const origin = new THREE.Vector3(100, 7, -40);
    const samples = Array.from({ length: 5 }, (_, i) => ({
      time: i * 0.1, distance: i, run: 0,
      values: {
        "motion.position-x": origin.x + i * Math.sin(yaw),
        "motion.position-y": 11,
        "motion.position-z": origin.z + i * Math.cos(yaw),
        "motion.yaw": yaw,
      },
    }));
    const runtime = probe(samples);
    Object.assign(runtime, { origin, canvas: { dataset: {} } });
    const pose = {
      x: samples[4]!.values["motion.position-x"], y: 11,
      z: samples[4]!.values["motion.position-z"], yaw,
    };
    const group = new THREE.Group();
    const applyPose = Reflect.get(runtime, "pose") as (group: THREE.Group, pose: NonNullable<SpectateReading["pose"]>, side: "a") => void;
    applyPose.call(runtime, group, pose, "a");
    group.updateMatrixWorld(true);
    try {
      runtime.updateTrail(0, { time: 0.4, distance: 4, pose, values: samples[4]!.values });
      const trail = runtime.trails[0]!;
      trail.mesh.updateMatrixWorld(true);
      expect(trail.mesh.count).toBeGreaterThan(0);
      const segmentsPerWheel = trail.mesh.count / 4;
      for (let wheel = 0; wheel < 4; wheel++) {
        const offset = wheelOffsets[wheel]!;
        const anchor = group.localToWorld(new THREE.Vector3(offset[0], -0.42, offset[1]));
        const matrix = new THREE.Matrix4();
        trail.mesh.getMatrixAt((wheel + 1) * segmentsPerWheel - 1, matrix);
        const ends = [-0.5, 0.5].map(z => new THREE.Vector3(0, 0, z).applyMatrix4(matrix).applyMatrix4(trail.mesh.matrixWorld));
        expect(Math.min(...ends.map(end => end.distanceTo(anchor)))).toBeLessThan(1e-5);
        expect(anchor.y + origin.y).toBeCloseTo(11 - 0.42);
      }
      expect(samples[4]!.values["motion.yaw"]).toBe(yaw);
    } finally { for (const trail of runtime.trails) if (trail) disposeTireTrailResource(trail); }
  }
});
