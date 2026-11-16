/** Canonical replay coordinates use the opposite X handedness to presentation; Z and elevation stay unchanged. */
export function replayDisplayX(x: number): number {
  return -x;
}

export function replayDisplayYaw(yaw: number): number {
  return -yaw;
}
