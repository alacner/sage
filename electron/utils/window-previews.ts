interface Owner {
  id: number;
  isDestroyed(): boolean;
  once(event: 'destroyed', listener: () => void): unknown;
  removeListener(event: 'destroyed', listener: () => void): unknown;
}
/** One preview per window; replacement, expiry, use and window close all release its listener/timer. */
export class WindowPreviews<T> {
  private entries = new Map<number, {value:T; cleanup():void}>();
  get size() { return this.entries.size; }
  get(id:number):T|undefined { return this.entries.get(id)?.value; }
  delete(id:number):void {
    const previous = this.entries.get(id);
    this.entries.delete(id); previous?.cleanup();
  }
  set(owner:Owner, value:T, ttl=15*60*1000):void {
    this.delete(owner.id);
    if (owner.isDestroyed()) throw Error('Preview window closed');
    const close = () => this.delete(owner.id);
    const timer = setTimeout(close, ttl); timer.unref();
    this.entries.set(owner.id, {value, cleanup:() => {clearTimeout(timer); owner.removeListener('destroyed', close);}});
    owner.once('destroyed', close);
  }
}
