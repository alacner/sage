/** Stop a turn from repeatedly reformulating actions after clear AI-review denials. */
export class ReviewDenialCircuit {
  private outcomes: boolean[] = [];
  private consecutiveDenials = 0;
  private stopped = false;
  record(decision: 'allow'|'ask'|'deny', reviewed=true) {
    if (this.stopped) return {stopped:true, consecutive:this.consecutiveDenials, denials:this.outcomes.filter(Boolean).length};
    const denied=decision==='deny';
    this.consecutiveDenials=denied?this.consecutiveDenials+1:0;
    if(!reviewed)return {stopped:false,consecutive:this.consecutiveDenials,denials:this.outcomes.filter(Boolean).length};
    this.outcomes.push(denied);
    if(this.outcomes.length>50)this.outcomes.shift();
    const denials=this.outcomes.filter(Boolean).length;
    if(this.consecutiveDenials>=3||denials>=10)this.stopped=true;
    return {stopped:this.stopped, consecutive:this.consecutiveDenials, denials};
  }
  get isStopped(){return this.stopped;}
}
