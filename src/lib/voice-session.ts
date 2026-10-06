/** Serialize permission/capture startup, and cancel a pending start when the key is released. */
export class VoiceSession {
  private revision = 0;
  private queue: Promise<void> = Promise.resolve();
  private capture?: { stop(): void };
  wanted = false;
  private holdRevision?: number;
  constructor(private readonly hooks: {
    prepare(): Promise<boolean>;
    capture(): Promise<{ stop(): void }>;
    start(): Promise<boolean>;
    stop(): Promise<unknown>;
    active(value: boolean): void;
    requested?(value: boolean): void;
    error(error: unknown): void;
  }) {}
  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.hooks.requested?.(true);
    const revision = ++this.revision;
    const current = () => revision === this.revision && this.wanted;
    this.queue = this.queue.catch(() => {}).then(async () => {
      if (!current()) return;
      let succeeded = false;
      try {
        if (!await this.hooks.prepare() || !current()) return;
        const capture = await this.hooks.capture();
        if (!current()) { capture.stop(); return; }
        this.capture = capture;
        const started = await this.hooks.start();
        if (!current()) { await this.hooks.stop(); return; }
        if (!started) return;
        succeeded = true; this.hooks.active(true);
      } catch (error) { if (current()) this.hooks.error(error); }
      finally {
        if (current() && !succeeded) { this.capture?.stop(); this.capture = undefined; this.wanted = false; this.hooks.requested?.(false); this.hooks.active(false); }
      }
    });
  }
  stop(): Promise<void> {
    this.wanted = false; ++this.revision;
    this.holdRevision = undefined;
    this.hooks.requested?.(false);
    this.capture?.stop(); this.capture = undefined;
    this.hooks.active(false);
    this.queue = this.queue.catch(() => {}).then(() => this.hooks.stop()).then(() => {}, () => {});
    return this.queue;
  }
  toggle(): void { if (this.wanted) this.stop(); else this.start(); }
  beginHold(): void {
    if (this.wanted) return;
    this.start(); this.holdRevision = this.revision;
  }
  endHold(): void { if (this.holdRevision === this.revision) this.stop(); }
  ended(): void { this.stop(); }
}
