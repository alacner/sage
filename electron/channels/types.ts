/**
 * Channel Plugin System
 *
 * 借鉴 OpenClaw 的 channel 功能，为定时任务提供外部输出/输入能力。
 * 采用插件架构：每个 channel 类型实现 ChannelPlugin 接口，
 * 由 registry 统一注册管理。
 *
 * 内置插件：
 * - email          : SMTP 邮件
 * - wechat         : 企业微信群机器人
 * - dingtalk       : 钉钉群机器人
 * - feishu-webhook : 飞书自定义群机器人（单向，只发不收）
 * - feishu-app     : 飞书应用机器人（双向，收发均支持）
 * - telegram       : Telegram Bot
 */

/** 通知消息体（调度器执行完任务后构造）。 */
export interface ChannelMessage {
  /** 消息标题。 */
  title: string;
  /** 正文（Markdown 纯文本，各插件按需转换）。 */
  content: string;
  /** 关联的任务名。 */
  taskName?: string;
  /** 运行状态。 */
  runStatus?: 'success' | 'failed' | 'running';
  /** 项目名。 */
  projectName?: string;
  /** 时间戳。 */
  timestamp?: number;
}

/**
 * 将网络层的 fetch 错误翻译为人类可读的中文诊断信息。
 * 各 channel 插件在 catch 中调用此函数，统一错误描述风格。
 */
export function diagnoseNetworkError(err: any, target?: string): string {
  const cause = err?.cause;
  let detail = err?.message ?? String(err);
  const hostname = target ? `（${target}）` : '';
  if (cause?.code === 'ENOTFOUND') {
    return `DNS 解析失败${hostname}：无法找到主机 ${cause?.hostname || ''}，请检查网络或 DNS 设置`;
  }
  if (cause?.code === 'ECONNREFUSED') {
    return `连接被拒绝${hostname}：目标服务器拒绝了连接，请检查 Webhook URL 是否正确`;
  }
  if (cause?.code === 'ETIMEDOUT' || err?.name === 'TimeoutError') {
    return `连接超时${hostname}：无法连接到目标服务器，请检查网络连通性或代理设置`;
  }
  if (cause?.code === 'ECONNRESET') {
    return `连接被重置${hostname}：可能是防火墙或代理中断了连接`;
  }
  if (cause?.code === 'CERT_HAS_EXPIRED' || cause?.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || cause?.code === 'SELF_SIGNED_CERT_IN_CHAIN') {
    return `SSL 证书错误${hostname}（${cause?.code}）：目标服务器的证书验证失败`;
  }
  if (cause?.code === 'EAI_AGAIN') {
    return `DNS 临时失败${hostname}：网络可能不稳定，请稍后重试`;
  }
  if (cause?.code === 'UND_ERR_SOCKET' || cause?.code === 'UND_ERR_CONNECT_TIMEOUT') {
    return `底层网络错误${hostname}（${cause?.code}）：可能是代理或防火墙阻断`;
  }
  if (cause) {
    return `${detail}（原因: ${cause?.code || cause?.message || 'unknown'}）`;
  }
  return detail;
}

/** 配置表单字段定义。 */
export interface ChannelField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'email' | 'number' | 'url' | 'select';
  options?:Array<{value:string;label:string}>;
  required: boolean;
  placeholder?: string;
  help?: string;
  /** 默认值。 */
  defaultValue?: string;
}

/**
 * 发送回执（平台给回来的定位信息）。
 *
 * 为什么不只回一个 ok：ok=true 只说明平台接受了，不代表「你在看的那个会话」收到了。
 * 把 messageId / chatId 结构化回传（而不是拼好的中文串），渲染层才能按语言组词，
 * 用户也才能拿 chat_id 去对「到底发进了哪个群」。
 */
export interface ChannelSendReceipt {
  messageId?: string;
  chatId?: string;
  receiveIdType?: string;
}

/** 发送结果。 */
export interface ChannelSendResult {
  ok: boolean;
  error?: string;
  receipt?: ChannelSendReceipt;
}

/**
 * 入站解析结果（从外部平台的 webhook 请求体中提取消息）。
 */
export interface InboundParseResult {
  /** 提取到的消息正文。 */
  text: string;
  /** 发送者标识。 */
  senderId?: string;
  /** 发送者显示名。 */
  senderName?: string;
  /** 是否是一条有效消息（false = 无需处理，例如事件订阅验证）。 */
  isMessage: boolean;
  /** 需要返回给平台的响应体（JSON 或纯文本）。 */
  response?: any;
}

/**
 * Channel 插件接口。每个插件负责一种外部通知方式。
 *
 * 双向能力：
 * - 出站：send() / test() — 把消息发到外部平台
 * - 入站：parseInbound() — 从外部平台的 webhook 请求中提取消息
 */
export interface ChannelPlugin {
  /** 插件类型标识（唯一）。 */
  type: string;
  /** 人类可读名称。 */
  label: string;
  /** 表单字段定义。 */
  fields: ChannelField[];
  /** 校验配置，返回 null 表示通过，否则返回错误描述。 */
  validate(config: Record<string, string>): string | null;
  /** 发送一条消息。 */
  send(config: Record<string, string>, message: ChannelMessage): Promise<ChannelSendResult>;
  /** 测试连通性（与 send 类似但发一条测试消息）。 */
  test(config: Record<string, string>): Promise<ChannelSendResult>;
  /**
   * 解析入站 webhook 请求体，提取消息正文和发送者。
   * 不同平台（企业微信/钉钉/飞书）的回调格式不同，由各插件自行解析。
   * 返回 isMessage=false 表示无需处理（如 URL 验证请求）。
   * 可选实现——不支持入站的渠道返回 null。
   */
  parseInbound?(body: any, headers: Record<string, string>, config: Record<string, string>): InboundParseResult | null;
  /**
   * 本插件自己往渠道诊断通道记了 outbound 事件（目前只有 feishu-app）。
   * 注册表据此兜底记一条通用出站结果：不兜底则那些渠道在面板上“没数据”，
   * 兜底了则飞书会出现两条 outbound，后写入的会把带 message_id 的那条挤成非最新。
   */
  reportsOwnDiagnostics?: boolean;
}

/**
 * 把 ChannelMessage 格式化为简洁的 Markdown 文本（供 webhook 类渠道使用）。
 */
export function formatMessageMarkdown(message: ChannelMessage): string {
  // 如果没有 taskName，认为是广播消息或权限请求等，直接使用 content
  // 这样用户可以完全控制消息格式，不会被额外的 title/timestamp 干扰
  if (!message.taskName) {
    return message.content || '';
  }
  
  // 有 taskName，认为是定时任务通知，添加完整的元数据格式化
  const lines: string[] = [];
  lines.push(`## ${message.title}`);
  lines.push('');
  const statusEmoji = message.runStatus === 'success' ? '✅'
    : message.runStatus === 'failed' ? '❌'
    : '⏳';
  lines.push(`**任务**: ${message.taskName} ${statusEmoji}`);
  if (message.projectName) {
    lines.push(`**项目**: ${message.projectName}`);
  }
  if (message.timestamp) {
    lines.push(`**时间**: ${new Date(message.timestamp).toLocaleString('zh-CN')}`);
  }
  lines.push('');
  if (message.content) {
    lines.push(message.content);
  }
  return lines.join('\n');
}

/**
 * 构造一条纯文本消息（供邮件等渠道使用）。
 */
export function formatMessagePlain(message: ChannelMessage): string {
  const lines: string[] = [];
  lines.push(message.title);
  lines.push('='.repeat(Math.min(60, message.title.length || 10)));
  lines.push('');
  if (message.taskName) {
    lines.push(`任务: ${message.taskName}`);
  }
  if (message.projectName) {
    lines.push(`项目: ${message.projectName}`);
  }
  if (message.timestamp) {
    lines.push(`时间: ${new Date(message.timestamp).toLocaleString('zh-CN')}`);
  }
  if (message.runStatus) {
    const statusText = message.runStatus === 'success' ? '成功'
      : message.runStatus === 'failed' ? '失败'
      : '运行中';
    lines.push(`状态: ${statusText}`);
  }
  lines.push('');
  if (message.content) {
    lines.push(message.content);
  }
  return lines.join('\n');
}
