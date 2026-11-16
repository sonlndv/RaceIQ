/** Keep terminal wire evidence in the native capture without replaying stale laps. */
export class F1SessionLifecycle {
  private activeUid: bigint | null = null;
  private closedUid: bigint | null = null;
  private player: number | null = null;
  private readonly retiredUids = new Set<bigint>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = false;
  private queue: Promise<void> = Promise.resolve();

  private readonly finalize: () => Promise<void>;
  private readonly onError: (error: unknown) => void;
  private readonly graceMs: number;
  constructor(finalize: () => Promise<void>, onError: (error: unknown) => void, graceMs = 300) {
    this.finalize = finalize;
    this.onError = onError;
    this.graceMs = graceMs;
  }

  private boundary(frame: Buffer): boolean {
    if (frame.length < 29 || frame.readUInt16LE(0) !== 2025 || frame[2] !== 25) return false;
    const uid = frame.readBigUInt64LE(7);
    if (uid === 0n || this.retiredUids.has(uid)) return false;
    const event = frame[6] === 3 && frame.length >= 33 ? frame.toString("ascii", 29, 33) : null;
    return this.activeUid !== uid || event === "SSTA" || event === "FLBK";
  }

  accept(frame: Buffer): "record" | "finish" | "ignore" {
    if (frame.length < 29 || frame.readUInt16LE(0) !== 2025 || frame[2] !== 25) return "record";
    const uid = frame.readBigUInt64LE(7);
    const event = frame[6] === 3 && frame.length >= 33 ? frame.toString("ascii", 29, 33) : null;
    // UID0 is auxiliary evidence, never a session identity or a resume signal.
    if (uid === 0n) {
      if (this.activeUid === null) return "ignore";
      if (this.closedUid !== null) {
        return this.pending && event === "RTMT" && frame.length >= 34 && frame[33] === this.player && frame[27] === this.player
          ? "record" : "ignore";
      }
      return event === "SEND" || event === "SSTA" || event === "FLBK" ? "ignore" : "record";
    }
    if (this.retiredUids.has(uid)) return "ignore";
    if (this.boundary(frame)) {
      if (this.activeUid !== null && this.activeUid !== uid) {
        this.retiredUids.add(this.activeUid);
        if (this.retiredUids.size > 32) this.retiredUids.delete(this.retiredUids.values().next().value!);
      }
      this.activeUid = uid;
      this.closedUid = null;
      this.player = frame[27] < 22 ? frame[27] : null;
    }
    if (this.closedUid === uid) return "ignore";
    if (frame[27] < 22) this.player = frame[27];
    const playerRetired = event === "RTMT" && frame.length >= 34 && frame[33] === this.player;
    if (event === "SEND" || playerRetired) {
      this.closedUid = uid;
      return "finish";
    }
    return "record";
  }

  /** Serialize recording and boundaries with timer publication, including async native writes. */
  handle(frame: Buffer, record: () => Promise<void>): Promise<void> {
    return this.enqueue(async () => {
      if (this.pending && this.boundary(frame)) await this.finish();
      const action = this.accept(frame);
      if (action === "ignore") return;
      await record();
      if (action === "finish") {
        this.pending = true;
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.enqueue(() => this.finish()).catch(this.onError);
        }, this.graceMs);
      }
    });
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }

  private async finish(): Promise<void> {
    clearTimeout(this.timer ?? undefined);
    this.timer = null;
    if (!this.pending) return;
    this.pending = false;
    await this.finalize();
  }

  /** Flush terminal publication before disconnect/stop; closed UID suppression survives restart. */
  flush(): Promise<void> {
    return this.enqueue(() => this.finish());
  }

  /** Game detection must not cut short an already scheduled terminal drain. */
  disconnect(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.pending) await this.finalize();
    });
  }
}
