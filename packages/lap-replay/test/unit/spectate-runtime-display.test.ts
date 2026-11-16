import { expect, test } from "bun:test";
import * as THREE from "three";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { createRibbonPool, disposeRibbonPool } from "@raceiq/scene-3d/wireframe/LineResources";
import type { ReplaySession, SpectateReading } from "../../contracts/spectate";
import { geometry, origin } from "../support/spectate-track-geometry";

initGameAdapters({ f1Experiments: true, iracingAdapter: true, ams2Adapter: true });

// The preserved Austria T1 entry/exit vectors, in canonical X/Z metres.
const entry = { x: 33.3769, z: 9.8816 }, exit = { x: 19.4883, z: -28.3745 };
const turn = [
  { x: -entry.x, z: -entry.z }, { x: 0, z: 0 }, exit,
  { x: exit.x * 2, z: exit.z * 2 }, { x: exit.x * 3, z: exit.z * 3 },
];

function sceneProbe(gameId = "f1-2025", points = turn, elevation = 4) {
  const runtime = geometry(gameId, points);
  const camera = new THREE.PerspectiveCamera(50, 1.4, 0.05, 50000);
  camera.position.set(80, 160, 100);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const a: SpectateReading = { time: 0.05, distance: 1, values: {}, pose: { x: 0, y: elevation, z: 0, yaw: Math.atan2(entry.x, entry.z) } };
  const b: SpectateReading = { ...a, pose: null };
  const snapshot = { a, b, time: 0.05, playing: false, seeking: false, speed: 1, seekGeneration: 0 };
  const groups = [new THREE.Group(), new THREE.Group()];
  const markers = [new THREE.Sprite(new THREE.SpriteMaterial()), new THREE.Sprite(new THREE.SpriteMaterial())];
  const edgePool = createRibbonPool(), centerLinePool = createRibbonPool();
  const linePools = [createRibbonPool(), createRibbonPool()], schematicLinePools = [createRibbonPool(), createRibbonPool()];
  const canvas = { dataset: {} as Record<string, string>, clientHeight: 800 };
  const probe = Object.assign(runtime, {
    camera, groups, markers, edgePool, centerLinePool, linePools, schematicLinePools, canvas,
    controls: { target: new THREE.Vector3(), update() {} },
    controller: { getSnapshot: () => snapshot, getFrameSnapshot: () => snapshot },
    disposed: false, initialized: true, fpsCap: 30, lastRender: -Infinity, dirty: false,
    interactionPending: true, resizePending: false, pendingFrames: [], settleFrames: 0,
    zoomIdleUntil: 0, zoomSnap: null, zoomBlend: 0, pairFitRadius: 0, directionLock: false,
    lastZoomIndicatorPosition: -1, lastZoomIndicatorAvailable: false, zoomIndicator() {},
    targetScratch: new THREE.Vector3(), deltaScratch: new THREE.Vector3(), separationScratch: new THREE.Vector3(),
    quaternionScratch: new THREE.Quaternion(), sphericalScratch: new THREE.Spherical(),
    centerScratch: new THREE.Vector3(), positionScratch: new THREE.Vector3(), sizeScratch: new THREE.Vector3(),
    laneRight: new THREE.Vector3(), laneUp: new THREE.Vector3(), laneOffset: new THREE.Vector3(),
    modelLengths: [4, 4], track: new THREE.Group(), tireTrails: false, trails: [null, null],
    slots: groups.map(() => ({ body: { root: new THREE.Group() }, wheels: [], springs: [], config: null })),
    carModelMode: "solid", lastWheelUpdate: null, racingLine: false,
    resumePlaybackAfterFrames: false, ready() {},
    error(message: string) { throw new Error(message); },
    renderer: { render() { runtime.scene.updateMatrixWorld(true); } },
  });
  runtime.scene.add(...groups, ...markers);
  const pair = Reflect.get(runtime, "pair") as ReplaySession;
  for (const lap of [pair.a, pair.b]) if (lap)
    for (const sample of lap.samples) sample.values["motion.position-y"] = elevation;
  runtime.setOutline(null, {
    coordSystem: gameId === "f1-2025" ? "f1-2025" : "forza", centerLine: points,
    leftEdge: points.map(p => ({ x: p.x - 5, z: p.z })),
    rightEdge: points.map(p => ({ x: p.x + 5, z: p.z })), raceLine: points, pitLane: null,
  });
  probe.dirty = false;
  // Call production frame logic without a browser, GPU, or duplicated camera math.
  return {
    runtime: probe, snapshot,
    draw(render = false) {
      const previousDocument = globalThis.document, previousRaf = globalThis.requestAnimationFrame;
      Object.defineProperty(globalThis, "document", { configurable: true, value: { hidden: false } });
      globalThis.requestAnimationFrame = (() => 1) as typeof requestAnimationFrame;
      probe.dirty = render;
      probe.interactionPending = true;
      try { Reflect.get(probe, "draw").call(probe, 1000); }
      finally {
        Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
        globalThis.requestAnimationFrame = previousRaf;
      }
    },
    dispose() {
      for (const pool of [edgePool, centerLinePool, ...linePools, ...schematicLinePools]) disposeRibbonPool(pool);
      runtime.racingLinePoints.geometry.dispose();
      for (const material of Array.isArray(runtime.racingLinePoints.material) ? runtime.racingLinePoints.material : [runtime.racingLinePoints.material]) material.dispose();
      runtime.racingLinePoints.dispose();
      for (const line of Reflect.get(runtime, "estimatedLines") as THREE.LineSegments[]) {
        line.geometry.dispose();
        (line.material as THREE.Material).dispose();
      }
      for (const marker of markers) marker.material.dispose();
    },
  };
}

for (const gameId of ["f1-2025", "fm-2023"]) {
  test(`${gameId} renders Austria T1 as a right turn under camera rotation with aligned car heading`, () => {
    const probe = sceneProbe(gameId), { runtime, snapshot } = probe;
    try {
      const recorded = runtime.lineRuns[0][0]!;
      expect(recorded[0]!.x).toBeCloseTo(-(-entry.x - origin.x));
      const laneSources = Reflect.get(runtime, "projectedLaneSources") as { x: number; nativeX: number; tx: number; tz: number }[][][];
      const dots = Reflect.get(runtime, "racingLinePositions") as number[];
      expect(dots[0]).toBeCloseTo(recorded[0]!.x);
      expect(runtime.edgeRuns[0]![0]!.x).toBeCloseTo(recorded[0]!.x + 5);
      expect(laneSources[0]![0]![0]!.nativeX).toBeCloseTo(recorded[0]!.x);
      for (const theta of [-1.1, 0.4, 2.2]) {
        runtime.camera.position.setFromSphericalCoords(300, 0.12, theta).add(runtime.controls.target);
        runtime.camera.lookAt(runtime.controls.target);
        probe.draw();
        const screen = recorded.slice(0, 3).map(p => new THREE.Vector3(p.x, p.y, p.z).project(runtime.camera));
        const incoming = screen[1]!.clone().sub(screen[0]!), outgoing = screen[2]!.clone().sub(screen[1]!);
        expect(incoming.x * outgoing.y - incoming.y * outgoing.x).toBeLessThan(0);
        const group = runtime.groups[0]!;
        group.updateMatrixWorld(true);
        const front = group.localToWorld(new THREE.Vector3(1, 0, 0)).sub(group.position);
        const yaw = snapshot.a.pose!.yaw;
        expect(front.x).toBeCloseTo(-Math.sin(yaw));
        expect(front.z).toBeCloseTo(Math.cos(yaw));
        const source = laneSources[0]![0]![0]!;
        expect(source.tx * front.x + source.tz * front.z).toBeCloseTo(1);
        expect(group.position.y + origin.y).toBe(4);
      }
    } finally { probe.dispose(); }
  });
}

test("direction lock, paired fit, markers and pose projections share the reflected camera basis", () => {
  const probe = sceneProbe(), { runtime, snapshot } = probe;
  try {
    snapshot.b.pose = { x: 70, y: 24, z: -30, yaw: -0.8 };
    runtime.directionLock = true;
    runtime.camera.position.set(0, 4, 0.1);
    probe.draw();
    const yaw = snapshot.a.pose!.yaw;
    const behind = runtime.camera.position.clone().sub(runtime.controls.target).setY(0).normalize();
    const forward = new THREE.Vector3(-Math.sin(yaw), 0, Math.cos(yaw));
    expect(behind.dot(forward)).toBeCloseTo(-1);
    expect(runtime.controls.target.toArray()).toEqual([-25, 10, -35]);
    const separation = new THREE.Vector3(-70, 20, -30).applyQuaternion(runtime.camera.quaternion.clone().invert());
    const tangent = Math.tan(THREE.MathUtils.degToRad(runtime.camera.fov / 2));
    const required = (Math.max(Math.abs(separation.x) / (2 * tangent * runtime.camera.aspect), Math.abs(separation.y) / (2 * tangent)) + Math.abs(separation.z) / 2) * 1.15 + 5;
    expect(runtime.pairFitRadius).toBeCloseTo(required);
    for (const [side, reading] of [["a", snapshot.a], ["b", snapshot.b]] as const) {
      Reflect.get(runtime, "projectPose").call(runtime, side, reading.pose);
      const pose = reading.pose!;
      const projected = new THREE.Vector3(-(pose.x - origin.x), pose.y - origin.y, pose.z - origin.z).project(runtime.camera);
      expect(Number(runtime.canvas.dataset[`${side}ScreenX`])).toBeCloseTo(projected.x);
      expect(Number(runtime.canvas.dataset[`${side}ScreenY`])).toBeCloseTo(projected.y);
    }
    for (let side = 0; side < 2; side++) {
      Reflect.get(runtime, "updatePositionMarker").call(runtime, side, side === 0 ? snapshot.a.pose : snapshot.b.pose);
      const marker = runtime.markers[side]!;
      const expected = runtime.groups[side]!.position.clone().add(new THREE.Vector3(0, 2, 0))
        .addScaledVector(new THREE.Vector3(0, 1, 0).applyQuaternion(runtime.camera.quaternion), (side === 0 ? 1 : -1) * marker.scale.x / 2);
      expect(marker.position.distanceTo(expected)).toBeLessThan(1e-6);
    }
    runtime.modelLengths = [0.01, 0.01];
    probe.draw(true);
    for (let side = 0; side < 2; side++) {
      const marker = runtime.markers[side]!;
      expect(marker.position.distanceTo(runtime.groups[side]!.position)).toBeGreaterThan(0);
      const projected = marker.position.clone().project(runtime.camera);
      expect(Number(runtime.canvas.dataset[side === 0 ? "aMarkerScreenX" : "bMarkerScreenX"])).toBeCloseTo(projected.x);
      expect(marker.scale.x).toBeGreaterThan(0);
    }
    expect(runtime.canvas.dataset.aX).toBe("0");
    expect(runtime.canvas.dataset.bX).toBe("70");
    expect(snapshot.b.pose.x).toBe(70);
  } finally { probe.dispose(); }
});

test("schematic A/B lanes and marker positions stay attached through zoom blend and camera rotation", () => {
  const points = Array.from({ length: 8 }, (_, i) => ({ x: i * 3, z: i * 4 }));
  const probe = sceneProbe("f1-2025", points, 12), { runtime, snapshot } = probe;
  try {
    snapshot.a.pose = { x: 3, y: 12, z: 4, yaw: Math.atan2(3, 4) };
    snapshot.b.pose = { ...snapshot.a.pose };
    for (const theta of [-1.2, 0.5, 2.3]) {
      for (const radius of [110, 500]) {
        runtime.camera.position.setFromSphericalCoords(radius, 0.55, theta).add(runtime.controls.target);
        runtime.camera.lookAt(runtime.controls.target);
        probe.draw(true);
        expect(runtime.zoomBlend).toBeGreaterThan(0);
        const lanes = Reflect.get(runtime, "schematicLaneRuns") as { x: number; y: number; z: number }[][][];
        for (let side = 0; side < 2; side++) {
          const point = lanes[side]![0]![1]!;
          expect(runtime.markers[side]!.position.distanceTo(new THREE.Vector3(point.x, point.y, point.z))).toBeLessThan(1e-6);
        }
        const midpoint = runtime.markers[0]!.position.clone().add(runtime.markers[1]!.position).multiplyScalar(0.5);
        expect(midpoint.x).toBeCloseTo(-(3 - origin.x));
        expect(midpoint.z).toBeCloseTo(4 - origin.z);
        expect(midpoint.y + origin.y).toBeCloseTo(THREE.MathUtils.lerp(12, 0, runtime.zoomBlend));
        const view = new THREE.Vector3(0, 0, -1).applyQuaternion(runtime.camera.quaternion);
        const centerDepth = new THREE.Vector3(-(3 - origin.x), -origin.y, 4 - origin.z).sub(runtime.camera.position).dot(view);
        const markerDepth = midpoint.clone().sub(runtime.camera.position).dot(view);
        const a = runtime.markers[0]!.position.clone().project(runtime.camera), b = runtime.markers[1]!.position.clone().project(runtime.camera);
        const separationPixels = Math.hypot(a.x - b.x, (a.y - b.y) / runtime.camera.aspect) * runtime.canvas.clientHeight * runtime.camera.aspect / 2;
        expect(separationPixels).toBeCloseTo(6 * runtime.zoomBlend * centerDepth / markerDepth, 4);
      }
    }
  } finally { probe.dispose(); }
});

test("whole-track fit/reset centers the reflected bounds without changing height or scale", () => {
  const probe = sceneProbe("fm-2023", [{ x: 120, z: 10 }, { x: 160, z: 50 }]), { runtime } = probe;
  try {
    Reflect.get(runtime, "fit").call(runtime);
    expect(runtime.controls.target.toArray()).toEqual([-130, -4, 10]);
    expect(runtime.camera.position.x).toBe(-130);
    expect(runtime.camera.up.toArray()).toEqual([0, 1, 0]);
    const radius = Reflect.get(runtime, "fitRadius") as number;
    expect(runtime.camera.position.y).toBeCloseTo(radius - 4);
    expect(runtime.camera.position.z).toBeCloseTo(10 + radius * 0.002);
  } finally { probe.dispose(); }
});

test("the opposite canonical corner remains visibly left rather than special-casing Austria", () => {
  const probe = sceneProbe("fm-2023", turn.map(point => ({ x: -point.x, z: point.z })));
  try {
    const { runtime } = probe;
    runtime.camera.position.set(0, 300, 0.1);
    runtime.camera.lookAt(runtime.controls.target);
    probe.draw();
    const screen = runtime.lineRuns[0][0]!.slice(0, 3).map(point => new THREE.Vector3(point.x, point.y, point.z).project(runtime.camera));
    const incoming = screen[1]!.clone().sub(screen[0]!), outgoing = screen[2]!.clone().sub(screen[1]!);
    expect(incoming.x * outgoing.y - incoming.y * outgoing.x).toBeGreaterThan(0);
  } finally { probe.dispose(); }
});
