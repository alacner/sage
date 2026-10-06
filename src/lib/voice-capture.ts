/**
 * 渲染进程麦克风采集：getUserMedia 采音 100% 记在 Sage.app 名下（会弹系统授权框并
 * 出现在 系统设置→隐私与安全性→麦克风 列表），规避子进程请求麦克风不被 TCC 记录的问题。
 * 采集 16kHz 单声道 Float32 PCM，base64 后经 IPC 送给主进程→Swift 识别助手。
 * 全链路打点经 voiceDiag 汇入主进程 voice.log，便于打包态排查授权问题。
 */
export interface VoiceCapture {
  stop: () => void;
}

function diag(msg: string): void {
  try { (window as any).api?.voiceDiag?.(msg); } catch { /* 诊断不影响主链路 */ }
}

function float32ToBase64(f: Float32Array): string {
  const bytes = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

export async function startVoiceCapture(onChunk: (b64: string) => void, deviceId?: string, onLevel?: (level: number) => void): Promise<VoiceCapture> {
  diag(`getUserMedia requesting… mediaDevices=${!!navigator.mediaDevices} secure=${typeof window !== 'undefined' ? window.isSecureContext : 'n/a'} device=${deviceId || 'system-default'}`);
  const audio: MediaTrackConstraints = { channelCount: 1, echoCancellation: true, noiseSuppression: true };
  let stream: MediaStream;
  try {
    if (deviceId) audio.deviceId = { exact: deviceId };
    stream = await navigator.mediaDevices.getUserMedia({ audio });
  } catch (e) {
    diag(`getUserMedia REJECTED: ${(e as Error)?.name}: ${(e as Error)?.message}`);
    // 指定设备不存在/被占用（OverconstrainedError/NotFound）时回退系统默认，避免语音输入直接不可用
    if (!deviceId) throw e;
    diag('fallback to system default device');
    delete audio.deviceId;
    stream = await navigator.mediaDevices.getUserMedia({ audio });
  }
  diag('getUserMedia granted, creating AudioContext(16k)');
  // 固定 16kHz 采样率，与助手侧 AVAudioFormat 对齐，避免重采样偏差
  const ctx = new AudioContext({ sampleRate: 16000 });
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = (e) => {
    const data = e.inputBuffer.getChannelData(0);
    // 可选电平回调（RMS 0~1）：桌面宠物的录音圆点随音量节奏脉动
    if (onLevel) {
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      onLevel(Math.min(1, Math.sqrt(sum / data.length) * 6));
    }
    onChunk(float32ToBase64(data));
  };
  src.connect(proc);
  proc.connect(ctx.destination);
  await ctx.resume();
  diag(`capture running: ctx.state=${ctx.state} sampleRate=${ctx.sampleRate}`);
  return {
    stop() {
      try { proc.disconnect(); src.disconnect(); } catch { /* 已断开 */ }
      proc.onaudioprocess = null;
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}
