import { useQuery } from "@tanstack/react-query";
import { authenticatedFetch } from "@/lib/rpc";

export interface SandboxSession {
  id: string;
  trackId: number;
  trackName: string;
  sessionType: string;
  startedAt: string;
  updatedAt: string;
  driverCount: number;
  lapCount: number;
  playerCarIndex: number | null;
  closed: boolean;
}

export interface SandboxLap {
  id: string;
  lapNumber: number;
  attempt: number;
  lapTimeSec: number | null;
  sectorsSec: [number | null, number | null, number | null];
  valid: boolean | null;
  status: string;
  source: string;
  completed: boolean;
  recordedAt: string;
}

export interface SandboxDriver {
  carIndex: number;
  name: string;
  teamId: number | null;
  isPlayer: boolean;
  telemetryRestricted: boolean;
  laps: SandboxLap[];
  currentLap: {
    lapNumber: number | null;
    lapTimeSec: number | null;
    sectorsSec: [number | null, number | null, number | null];
    valid: boolean | null;
  } | null;
}

export interface SandboxSessionDetail {
  session: SandboxSession;
  drivers: SandboxDriver[];
  coverage: {
    message: string;
    lastPacketAt: string | null;
    packetCount: number;
    missingData: boolean;
  };
}

class SessionRequestError extends Error {
  constructor(status: number) {
    super(status === 401 ? "Sign in to load Austria race session history." : status === 403 ? "You do not have access to Austria race session history." : `Session history request failed (HTTP ${status}).`);
  }
}

async function getSessionData<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await authenticatedFetch(path, { signal });
  if (!response.ok) throw new SessionRequestError(response.status);
  return response.json() as Promise<T>;
}

const pollingOptions = {
  refetchInterval: 2_000,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
  retry: false,
} as const;

// Query observers stop polling on unmount; consuming the signal cancels obsolete requests.
export function useSandboxSessions() {
  return useQuery({
    queryKey: ["sandbox", "f1", "sessions"],
    queryFn: ({ signal }) => getSessionData<{ sessions: SandboxSession[] }>("/api/sandbox/f1/sessions", signal),
    ...pollingOptions,
  });
}

export function useSandboxSession(id: string | null) {
  return useQuery({
    queryKey: ["sandbox", "f1", "sessions", id],
    queryFn: ({ signal }) => getSessionData<SandboxSessionDetail>(`/api/sandbox/f1/sessions/${encodeURIComponent(id!)}`, signal),
    enabled: id !== null,
    ...pollingOptions,
  });
}

export function formatLapTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return "—";
  const milliseconds = Math.round(seconds * 1_000);
  const minutes = Math.floor(milliseconds / 60_000);
  return `${minutes}:${((milliseconds % 60_000) / 1_000).toFixed(3).padStart(6, "0")}`;
}

export function formatSector(seconds: number | null): string {
  return seconds !== null && Number.isFinite(seconds) && seconds > 0 ? seconds.toFixed(3) : "—";
}

export function formatTimestamp(value: string | null): string {
  if (!value) return "Not received";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Unknown time";
}

export function formatLabel(value: string): string {
  return value.replace(/[_-]+/g, " ");
}
