import type { AppSettings } from '../../shared/types';
import { translate } from '../i18n';

type Snapshot = { draft: Partial<AppSettings>; pending: boolean; saving: boolean; error: string | null; saved: boolean };
/** Lives outside the settings tab: navigation/unmount cannot lose an in-flight or failed draft. */
export class SettingsAutosave {
  private queued: Partial<AppSettings> = {};
  private inFlight: Partial<AppSettings> = {};
  private revision = 'legacy';
  private listeners = new Set<() => void>();
  private state: Snapshot = { draft: {}, pending: false, saving: false, error: null, saved: false };
  constructor(private write: (patch: Partial<AppSettings>, revision: string) => Promise<AppSettings>) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<Snapshot>) {
    this.state = { ...this.state, ...patch, draft: { ...this.inFlight, ...this.queued } };
    this.listeners.forEach(fn => fn());
  }
  enqueue(patch: Partial<AppSettings>, revision: string) {
    if (!this.state.pending) this.revision = revision;
    this.queued = { ...this.queued, ...patch };
    this.publish({ pending: true });
    void this.drain();
  }
  retry() { this.publish({error:null}); void this.drain(); }
  discard() {
    if (this.state.saving) throw new Error(translate('settings.saveWait'));
    this.queued = {}; this.inFlight = {};
    this.publish({pending:false,error:null,saved:false});
  }
  private async drain() {
    if (this.state.saving || this.state.error) return;
    this.publish({saving:true});
    try {
      while (Object.keys(this.queued).length) {
        this.inFlight = this.queued; this.queued = {};
        this.publish({});
        const saved = await this.write(this.inFlight, this.revision);
        this.revision = saved._revision ?? 'legacy';
        this.inFlight = {};
      }
      this.publish({pending:false,saving:false,saved:true});
    } catch (e: any) {
      this.queued = {...this.inFlight,...this.queued}; this.inFlight = {};
      this.publish({pending:true,saving:false,error:e?.message ?? String(e)});
    }
  }
}
