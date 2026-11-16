import { parseF1Header, type F1Header } from "@raceiq/capture-formats/f1-2025/f1-wire";

export type Sectors = [number | null, number | null, number | null];
export const seconds = (ms: number): number | null => ms > 0 && Number.isFinite(ms) ? ms / 1000 : null;
export interface LapSample {
  carIndex: number; lapNumber: number; time: number | null; lastTime: number | null;
  sectors: Sectors; invalid: boolean; pit: boolean; active: boolean;
}
export interface HistoryLap { lapNumber: number; time: number | null; sectors: Sectors; flags: number; }
export type WirePacket = { header: F1Header } & (
  | { kind: "session"; trackId: number; sessionType: number; caution: boolean }
  | { kind: "participants"; drivers: Array<{ carIndex: number; name: string; teamId: number; restricted: boolean }> }
  | { kind: "laps"; cars: LapSample[] }
  | { kind: "history"; carIndex: number; laps: HistoryLap[] }
  | { kind: "event"; code: string }
  | { kind: "flags"; caution: boolean[] }
  | { kind: "other" }
);

/** F1 25 UDP v3 only. Reject truncated arrays rather than inventing absent slots. */
export function decodeSandboxWire(frame: Buffer): WirePacket | null {
  if (frame.length < 29 || frame.readUInt16LE(0) !== 2025 || frame[2] !== 25) return null;
  const header = parseF1Header(frame);
  if (!Number.isFinite(header.sessionTime)) return null;
  const body = frame.subarray(29);
  switch (header.packetId) {
    case 1:
      if (body.length < 125) return null;
      return { header, kind: "session", trackId: body.readInt8(7), sessionType: body[6]!, caution: body[124] !== 0 };
    case 4: {
      if (body.length < 1 || body[0]! > 22 || body.length < 1 + body[0]! * 57) return null;
      const drivers = [];
      for (let carIndex = 0; carIndex < body[0]!; carIndex++) {
        const o = 1 + carIndex * 57;
        const name = body.subarray(o + 7, o + 39);
        const end = name.indexOf(0);
        drivers.push({ carIndex, name: name.subarray(0, end < 0 ? 32 : end).toString("utf8"), teamId: body[o + 3]!, restricted: body[o + 39] === 0 });
      }
      return { header, kind: "participants", drivers };
    }
    case 2: {
      if (body.length < 22 * 57) return null;
      const cars: LapSample[] = [];
      for (let carIndex = 0; carIndex < 22; carIndex++) {
        const o = carIndex * 57;
        cars.push({ carIndex, lapNumber: body[o + 33]!, time: seconds(body.readUInt32LE(o + 4)), lastTime: seconds(body.readUInt32LE(o)),
          sectors: [seconds(body.readUInt16LE(o + 8) + body[o + 10]! * 60000), seconds(body.readUInt16LE(o + 11) + body[o + 13]! * 60000), null],
          invalid: body[o + 37] !== 0, pit: body[o + 34] !== 0 || body[o + 46] !== 0,
          active: body[o + 45] !== 0 && body[o + 45] !== 1 });
      }
      return { header, kind: "laps", cars };
    }
    case 11: {
      if (body.length < 7 || body[0]! >= 22 || body[1]! > 100 || body.length < 7 + body[1]! * 14) return null;
      const laps: HistoryLap[] = [];
      for (let i = 0; i < body[1]!; i++) {
        const o = 7 + i * 14;
        laps.push({ lapNumber: i + 1, time: seconds(body.readUInt32LE(o)), flags: body[o + 13]!, sectors: [
          seconds(body.readUInt16LE(o + 4) + body[o + 6]! * 60000), seconds(body.readUInt16LE(o + 7) + body[o + 9]! * 60000), seconds(body.readUInt16LE(o + 10) + body[o + 12]! * 60000),
        ] });
      }
      return { header, kind: "history", carIndex: body[0]!, laps };
    }
    case 7:
      if (body.length < 22 * 55) return null;
      return { header, kind: "flags", caution: Array.from({ length: 22 }, (_, i) => body.readInt8(i * 55 + 28) >= 3) };
    case 3:
      return body.length >= 4 ? { header, kind: "event", code: body.toString("ascii", 0, 4) } : null;
    default:
      return { header, kind: "other" };
  }
}
