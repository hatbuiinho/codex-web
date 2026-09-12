// Only server -> renderer events are replayed. Renderer commands are NEVER
// replayed: a lost acknowledgement does not mean a turn failed to start.
export class BridgeSession {
  sequence = 0;
  private bytes = 0;
  private frames: { sequence: number; json: string; bytes: number }[] = [];
  private sendFrame: ((json: string) => void) | null = null;

  // A single resumed thread can emit a large history snapshot (old
  // image-heavy threads exceed 40 MiB). Keep enough for that snapshot;
  // commands are never replayed and sessions expire after two minutes.
  constructor(private readonly maxBytes = 64 * 1024 * 1024) {}

  publish(message: unknown): void {
    const sequence = ++this.sequence;
    const json = JSON.stringify({ type: "bridge-event", sequence, message });
    const bytes = Buffer.byteLength(json);
    this.frames.push({ sequence, json, bytes });
    this.bytes += bytes;
    while (this.bytes > this.maxBytes && this.frames.length) {
      this.bytes -= this.frames.shift()!.bytes;
    }
    this.sendFrame?.(json);
  }

  attach(after: number, send: (json: string) => void): boolean {
    const oldest = this.frames[0]?.sequence ?? this.sequence + 1;
    if (
      !Number.isSafeInteger(after) ||
      after < oldest - 1 ||
      after > this.sequence
    ) {
      return false;
    }
    // Reconnect replays the exact missed suffix, including terminal events
    // and invoke results. Identical text deltas are still distinct events.
    for (const frame of this.frames)
      if (frame.sequence > after) send(frame.json);
    this.sendFrame = send;
    return true;
  }

  detach(): void {
    this.sendFrame = null;
  }
}
