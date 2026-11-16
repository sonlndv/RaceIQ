import { expect, test } from "bun:test";
import { overviewGeometry } from "../../ui/SpectateOverview";
import { replayDisplayX, replayDisplayYaw } from "../../ui/replay-display-coordinates";

const row = (startFrac: number, endFrac: number) => ({
  segment: { name: "T1", type: "corner", startFrac, endFrac }, number: 1, delta: null,
});
const coordinates = (path: string) => path.split(" ").map((point) => {
  const [x, y] = point.split(",").map(Number);
  return { x: x!, y: y! };
});

test("verified Austria T1 vectors bend right in the overview regardless of section selection", () => {
  // Canonical vectors from preserved track 17, lap 13 (lap number 5).
  const points = [
    { x: 0, z: 0, distance: 0, run: 0 },
    { x: 33.3769, z: 9.8816, distance: 50, run: 0 },
    { x: 52.8652, z: -18.4929, distance: 100, run: 0 },
  ];
  const original = structuredClone(points);
  const plain = overviewGeometry([points], 100, [])!;
  const selected = overviewGeometry([points], 100, [row(0, 1)])!;
  expect(selected.paths).toEqual(plain.paths);
  const [a, b, c] = coordinates(plain.paths[0]!);
  // SVG Y increases downward: a positive signed bend is clockwise/right.
  expect((b!.x - a!.x) * (c!.y - b!.y) - (b!.y - a!.y) * (c!.x - b!.x)).toBeGreaterThan(0);
  expect(selected.markers[0]!.sectionPaths).toEqual(selected.paths);
  expect(selected.markers[0]!.anchor).toEqual(selected.project(points[1]!));
  expect(points).toEqual(original);
});

test("interpolated section boundaries, focus vertices and both live poses share the track projection", () => {
  const points = [
    { x: 0, z: 0, distance: 0, run: 0 },
    { x: 20, z: 10, distance: 50, run: 0 },
    { x: 40, z: 20, distance: 100, run: 0 },
  ];
  const geometry = overviewGeometry([points], 100, [row(0.2, 0.8)])!;
  const marker = geometry.markers[0]!;
  const poseA = { x: 8, z: 4 }, poseB = { x: 32, z: 16 };
  const focusVertices = [poseA, { x: 20, z: 10 }, poseB].map(geometry.project);
  expect(coordinates(marker.sectionPaths[0]!)).toEqual(focusVertices);
  expect(marker.anchor).toEqual(focusVertices[1]);
  expect(geometry.project(poseA)).toEqual(focusVertices[0]);
  expect(geometry.project(poseB)).toEqual(focusVertices[2]);
  expect(geometry.project(poseA).x).toBeGreaterThan(geometry.project(poseB).x);
  expect(marker.seekable).toBe(true);
  expect(marker.segment.startFrac * 100).toBe(20);
});

test("numbered badge starts along the normal of the displayed tangent, not the canonical tangent", () => {
  const points = [
    { x: -100, z: -100, distance: 0, run: 0 },
    { x: 100, z: 100, distance: 100, run: 0 },
  ];
  const geometry = overviewGeometry([points], 100, [row(0, 1)])!;
  const { anchor, position } = geometry.markers[0]!;
  expect(position).not.toBeNull();
  const a = geometry.project(points[0]!), b = geometry.project(points[1]!);
  const dx = position!.x - anchor!.x, dy = position!.y - anchor!.y;
  expect(dx * (b.x - a.x) + dy * (b.y - a.y)).toBeCloseTo(0, 8);
  expect(Math.hypot(dx, dy)).toBeCloseTo(13, 8);
});

test("display yaw and X reflect consistently without changing elevation or forward Z", () => {
  for (const yaw of [-2.1, -0.3, 0, 0.8, 2.5]) {
    expect(Math.sin(replayDisplayYaw(yaw))).toBeCloseTo(replayDisplayX(Math.sin(yaw)), 12);
    expect(Math.cos(replayDisplayYaw(yaw))).toBeCloseTo(Math.cos(yaw), 12);
  }
});
