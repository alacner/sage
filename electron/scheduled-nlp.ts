/**
 * Scheduled Task NLP Parser
 *
 * 将自然语言（中文/英文）指令解析为结构化操作，无需 LLM。
 * 支持创建、修改、删除、暂停/启用、立即运行、列出等操作。
 */

import type { ScheduledTask, ScheduleConfig, ScheduleType, Weekday } from '../shared/types';

// ─── Action types ────────────────────────────────────────────────────────────

export type ScheduledAction =
  | { type: 'create'; schedule: ScheduleConfig; name: string; prompt: string; channelIds?: string[]; description: string }
  | { type: 'modify'; task: ScheduledTask; patch: Partial<Pick<ScheduledTask, 'name' | 'prompt' | 'schedule' | 'enabled' | 'channelIds'>>; description: string }
  | { type: 'delete'; task: ScheduledTask; description: string }
  | { type: 'toggle'; task: ScheduledTask; enabled: boolean; description: string }
  | { type: 'run'; task: ScheduledTask; description: string }
  | { type: 'list'; description: string }
  | { type: 'help'; description: string }
  | { type: 'unknown'; description: string };

// ─── Time helpers ────────────────────────────────────────────────────────────

interface ParsedTime { hour: number; minute: number }

const TIME_PERIOD: Record<string, number> = {
  '凌晨': 0, '早上': 0, '上午': 0, '早晨': 0, '清晨': 0,
  '中午': 12,
  '下午': 12,
  '傍晚': 12,
  '晚上': 12,
  '夜里': 12,
};

function parseTime(text: string): ParsedTime | null {
  // Determine period offset (下午/晚上 → +12)
  let offset = 0;
  for (const [period, off] of Object.entries(TIME_PERIOD)) {
    if (text.includes(period)) { offset = off; break; }
  }

  // "X点Y分" or "X点Y" or "X:Y"
  let m = text.match(/(\d{1,2})\s*[点:：]\s*(\d{1,2})/);
  if (m) {
    let h = parseInt(m[1]);
    if (h < 12 && offset) h += offset;
    return { hour: Math.min(h, 23), minute: parseInt(m[2]) };
  }

  // "X点半"
  m = text.match(/(\d{1,2})\s*点半/);
  if (m) {
    let h = parseInt(m[1]);
    if (h < 12 && offset) h += offset;
    return { hour: Math.min(h, 23), minute: 30 };
  }

  // "X点"
  m = text.match(/(\d{1,2})\s*点/);
  if (m) {
    let h = parseInt(m[1]);
    if (h < 12 && offset) h += offset;
    return { hour: Math.min(h, 23), minute: 0 };
  }

  // "HH:MM" (standalone)
  m = text.match(/(\d{1,2}):(\d{2})/);
  if (m) {
    let h = parseInt(m[1]);
    if (h < 12 && offset) h += offset;
    return { hour: Math.min(h, 23), minute: parseInt(m[2]) };
  }

  return null;
}

function formatTimeStr(t: ParsedTime): string {
  return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}

// ─── Weekday parsing ─────────────────────────────────────────────────────────

const WEEKDAY_MAP: Record<string, Weekday> = {
  '周日': 0, '星期天': 0, '星期日': 0,
  '周一': 1, '星期一': 1,
  '周二': 2, '星期二': 2,
  '周三': 3, '星期三': 3,
  '周四': 4, '星期四': 4,
  '周五': 5, '星期五': 5,
  '周六': 6, '星期六': 6,
};

const WEEKDAY_EN: Record<string, Weekday> = {
  'sunday': 0, 'monday': 1, 'tuesday': 2, 'wednesday': 3,
  'thursday': 4, 'friday': 5, 'saturday': 6,
};

const WEEKDAY_NAMES_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function parseWeekday(text: string): Weekday | null {
  for (const [k, v] of Object.entries(WEEKDAY_MAP)) {
    if (text.includes(k)) return v;
  }
  const lower = text.toLowerCase();
  for (const [k, v] of Object.entries(WEEKDAY_EN)) {
    if (lower.includes(k)) return v;
  }
  return null;
}

// ─── Schedule parsing ────────────────────────────────────────────────────────

interface ScheduleResult { schedule: ScheduleConfig; description: string }

function parseScheduleFromText(text: string): ScheduleResult | null {
  // "每隔N分钟" / "every N minutes"
  let m = text.match(/每隔\s*(\d+)\s*分钟/) || text.match(/每\s*(\d+)\s*分钟/) || text.match(/every\s+(\d+)\s*min/i);
  if (m) {
    const mins = parseInt(m[1]);
    return { schedule: { type: 'interval', intervalMinutes: mins }, description: `每隔 ${mins} 分钟` };
  }

  // "每小时的第N分钟"
  m = text.match(/每小时.*?第?\s*(\d+)\s*分/) || text.match(/hourly.*?(\d+)/i);
  if (m && (text.includes('每小时') || /hourly/i.test(text))) {
    const min = parseInt(m[1]);
    return { schedule: { type: 'hourly', minute: min }, description: `每小时第 ${min} 分钟` };
  }

  // "每小时" (no specific minute)
  if (text.includes('每小时') || /hourly/i.test(text)) {
    const time = parseTime(text);
    return { schedule: { type: 'hourly', minute: time?.minute ?? 0 }, description: `每小时` };
  }

  const time = parseTime(text);
  const timeStr = time ? formatTimeStr(time) : null;

  // "明天" / "tomorrow"
  if (text.includes('明天') || /tomorrow/i.test(text)) {
    if (time) {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(time.hour, time.minute, 0, 0);
      return { schedule: { type: 'once', at: d.toISOString() }, description: `明天 ${timeStr}` };
    }
  }

  // "后天"
  if (text.includes('后天')) {
    if (time) {
      const d = new Date();
      d.setDate(d.getDate() + 2);
      d.setHours(time.hour, time.minute, 0, 0);
      return { schedule: { type: 'once', at: d.toISOString() }, description: `后天 ${timeStr}` };
    }
  }

  // "每月N号/日"
  m = text.match(/每[个]?月\s*(\d{1,2})\s*[号日]/);
  if (m) {
    return {
      schedule: { type: 'monthly', monthDay: parseInt(m[1]), at: timeStr ?? '09:00' },
      description: `每月${m[1]}号 ${timeStr ?? '09:00'}`,
    };
  }

  // "每周X" / "weekly"
  if (text.includes('每周') || /weekly/i.test(text) || /every\s+(week|week)/i.test(text)) {
    const wd = parseWeekday(text);
    const wdName = wd !== null ? WEEKDAY_NAMES_ZH[wd] : '周一';
    return {
      schedule: { type: 'weekly', weekday: wd ?? 1, at: timeStr ?? '09:00' },
      description: `每${wdName} ${timeStr ?? '09:00'}`,
    };
  }

  // "每天" / "daily" / "every day"
  if (text.includes('每天') || text.includes('每日') || /daily/i.test(text) || /every\s*day/i.test(text)) {
    return {
      schedule: { type: 'daily', at: timeStr ?? '09:00' },
      description: `每天 ${timeStr ?? '09:00'}`,
    };
  }

  // Time only → assume daily
  if (time) {
    return {
      schedule: { type: 'daily', at: timeStr! },
      description: `每天 ${timeStr}`,
    };
  }

  return null;
}

// ─── Task name matching ──────────────────────────────────────────────────────

/** Extract a task name reference from command text (removes action verbs) */
function extractTaskNameRef(text: string): string {
  let s = text;
  // Remove action verbs
  s = s.replace(/^(删除|移除|去掉|取消|暂停|禁用|停用|关闭|启用|开启|激活|恢复|立即运行|马上执行|立即执行|运行|执行)\s*/, '');
  s = s.replace(/\s*(定时)?任务\s*$/, '');
  // Remove quotes
  s = s.replace(/[「」""'"]/g, '').trim();
  return s;
}

/** Find a task by fuzzy name match */
export function findTaskByPattern(pattern: string, tasks: ScheduledTask[]): ScheduledTask | undefined {
  if (!pattern) return undefined;
  const lower = pattern.toLowerCase().trim();

  // Exact match
  const exact = tasks.find((t) => t.name.toLowerCase() === lower);
  if (exact) return exact;

  // Contains
  const contains = tasks.find((t) => t.name.toLowerCase().includes(lower));
  if (contains) return contains;

  // Reverse contains (task name contains the pattern)
  const rev = tasks.find((t) => lower.includes(t.name.toLowerCase()));
  if (rev) return rev;

  // Character subsequence match
  return tasks.find((t) => {
    const name = t.name.toLowerCase();
    let ni = 0;
    for (const c of lower) {
      while (ni < name.length && name[ni] !== c) ni++;
      if (ni >= name.length) return false;
      ni++;
    }
    return true;
  });
}

// ─── Schedule description formatter ──────────────────────────────────────────

export function formatScheduleDescription(task: ScheduledTask): string {
  const { schedule } = task;
  switch (schedule.type) {
    case 'once':
      return schedule.at ? `一次性 ${new Date(schedule.at).toLocaleString()}` : '一次性';
    case 'interval':
      return `每隔 ${schedule.intervalMinutes} 分钟`;
    case 'hourly':
      return `每小时第 ${schedule.minute ?? 0} 分钟`;
    case 'daily':
      return `每天 ${schedule.at ?? '09:00'}`;
    case 'weekly': {
      const wd = schedule.weekday ?? 1;
      return `每${WEEKDAY_NAMES_ZH[wd]} ${schedule.at ?? '09:00'}`;
    }
    case 'monthly':
      return `每月${schedule.monthDay}号 ${schedule.at ?? '09:00'}`;
    default:
      return '未设置';
  }
}

// ─── Extract prompt from create text ─────────────────────────────────────────

/**
 * Remove schedule-related keywords from text to extract the remaining prompt.
 */
function extractPrompt(text: string): string {
  let s = text;
  // Remove leading action verbs
  s = s.replace(/^(帮我|请|麻烦)?\s*(创建|新建|添加|设置|加上)\s*/, '');
  // Remove "的定时任务" / "的任务"
  s = s.replace(/的?(定时)?任务\s*/g, '');
  // Remove schedule keywords (order matters: longer first)
  const scheduleKeywords = [
    '每隔', '每小时', '每个', '每月', '每周', '每天', '每日',
    '凌晨', '早上', '上午', '下午', '晚上', '傍晚', '中午', '夜里',
    '周一', '周二', '周三', '周四', '周五', '周六', '周日',
    '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日', '星期天',
    '明天', '后天',
  ];
  // Build regex for schedule keywords
  const kwPattern = new RegExp(scheduleKeywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  s = s.replace(kwPattern, '');
  // Remove time patterns
  s = s.replace(/\d{1,2}\s*[点:：]\s*\d{0,2}\s*分?半?/g, '');
  s = s.replace(/\d{1,2}\s*点半/g, '');
  s = s.replace(/\d{1,2}\s*点/g, '');
  s = s.replace(/\d{1,2}\s*[号日](?=\s|$)/g, '');
  // Remove connectors
  s = s.replace(/^[来做执行运行进行，,、\s]+/, '');
  s = s.replace(/[，,、\s]+$/, '');
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Extract a reasonable name from a prompt */
function nameFromPrompt(prompt: string): string {
  // Take first sentence or first 30 chars
  const firstLine = prompt.split(/[。！？\n]/)[0].trim();
  if (firstLine.length <= 30) return firstLine || prompt.slice(0, 30);
  return firstLine.slice(0, 30) + '…';
}

// ─── Main parser ─────────────────────────────────────────────────────────────

export function parseScheduledCommand(
  text: string,
  existingTasks: ScheduledTask[],
): ScheduledAction {
  const trimmed = text.trim();
  if (!trimmed) return { type: 'unknown', description: '请输入指令' };

  // ── Help ──
  if (/^(帮助|help|怎么用|用法|示例|example|\?)$/i.test(trimmed)) {
    return { type: 'help', description: '显示帮助' };
  }

  // ── List ──
  if (/(列出|查看|显示|有哪些|所有|看看).{0,4}(任务|定时)|list.*task|show.*task|what.*task|我的任务/i.test(trimmed)) {
    return { type: 'list', description: '列出所有定时任务' };
  }

  // ── Create (TRY FIRST — before delete/toggle/run, to avoid
  //    "每天9点运行XX" being misinterpreted as "run task XX") ──
  const scheduleResult = parseScheduleFromText(trimmed);
  if (scheduleResult) {
    // Heuristic: if the text ALSO matches a known management verb pattern
    // targeting an existing task, treat it as that action instead.
    const isExplicitManagement =
      /^(删除|移除|去掉|取消|暂停|禁用|停用|关闭|启用|开启|激活|恢复|把)\s/.test(trimmed);
    if (!isExplicitManagement) {
      const prompt = extractPrompt(trimmed);
      if (prompt) {
        const name = nameFromPrompt(prompt);
        return {
          type: 'create',
          schedule: scheduleResult.schedule,
          name,
          prompt,
          description: `创建定时任务：${scheduleResult.description}\n执行：「${prompt}」`,
        };
      }
    }
  }

  // ── Delete ──
  {
    const m = trimmed.match(/(?:删除|移除|去掉|取消|delete|remove)\s*[「」""'"]?(.+?)[「」""'"]?\s*$/i);
    if (m) {
      const ref = extractTaskNameRef(m[0]);
      const task = findTaskByPattern(ref || m[1].trim(), existingTasks);
      if (task) return { type: 'delete', task, description: `删除任务「${task.name}」` };
      return { type: 'unknown', description: `找不到名为「${ref || m[1].trim()}」的任务` };
    }
  }

  // ── Pause / Disable ──
  {
    const m = trimmed.match(/(?:暂停|禁用|停用|关闭|pause|disable|stop)\s*[「」""'"]?(.+?)[「」""'"]?\s*$/i);
    if (m) {
      const ref = extractTaskNameRef(m[0]);
      const task = findTaskByPattern(ref || m[1].trim(), existingTasks);
      if (task) return { type: 'toggle', task, enabled: false, description: `暂停任务「${task.name}」` };
      return { type: 'unknown', description: `找不到名为「${ref || m[1].trim()}」的任务` };
    }
  }

  // ── Enable ──
  {
    const m = trimmed.match(/(?:启用|开启|激活|恢复|enable|activate|resume)\s*[「」""'"]?(.+?)[「」""'"]?\s*$/i);
    if (m) {
      const ref = extractTaskNameRef(m[0]);
      const task = findTaskByPattern(ref || m[1].trim(), existingTasks);
      if (task) return { type: 'toggle', task, enabled: true, description: `启用任务「${task.name}」` };
      return { type: 'unknown', description: `找不到名为「${ref || m[1].trim()}」的任务` };
    }
  }

  // ── Run now ──
  {
    const m = trimmed.match(/(?:立即运行|马上执行|立即执行|立刻运行|运行|执行)\s*[「」""'"]?(.+?)[「」""'"]?\s*$/i);
    if (m && existingTasks.length > 0) {
      const ref = extractTaskNameRef(m[0]);
      const task = findTaskByPattern(ref || m[1].trim(), existingTasks);
      if (task) return { type: 'run', task, description: `立即运行任务「${task.name}」` };
      return { type: 'unknown', description: `找不到名为「${ref || m[1].trim()}」的任务` };
    }
  }

  // ── Modify: "把XX改成YY" ──
  {
    const m = trimmed.match(/把\s*[「」""'"]?(.+?)[」""'"]?\s*(?:的|的)?(?:时间|调度|指令|任务|内容|提示词)?\s*(?:改成|改为|变为|换成|修改为|变更为|调整成|调整为)\s*(.+)/);
    if (m) {
      const ref = m[1].trim();
      const newSpec = m[2].trim();
      const task = findTaskByPattern(ref, existingTasks);
      if (!task) return { type: 'unknown', description: `找不到名为「${ref}」的任务` };

      const sched = parseScheduleFromText(newSpec);
      if (sched) {
        return {
          type: 'modify',
          task,
          patch: { schedule: sched.schedule },
          description: `将「${task.name}」的调度改为 ${sched.description}`,
        };
      }
      return {
        type: 'modify',
        task,
        patch: { prompt: newSpec },
        description: `将「${task.name}」的指令改为「${newSpec}」`,
      };
    }
  }

  // ── Bare "创建/新建" without schedule → ask for more info ──
  if (/^(创建|新建|添加|设置)\s/.test(trimmed)) {
    return {
      type: 'unknown',
      description: '请告诉我调度和执行内容，例如：\n• 每天早上9点检查代码质量\n• 每周五下午5点生成周报\n• 每隔30分钟检查服务器状态',
    };
  }

  return {
    type: 'unknown',
    description: '没有理解这条指令。试试这样说：\n• 每天早上9点检查代码质量\n• 删掉"XXX"任务\n• 把"XXX"改成下午5点\n• 暂停"XXX"\n• 列出所有任务',
  };
}
