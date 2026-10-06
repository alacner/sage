/**
 * Email Channel — SMTP 发送
 *
 * 使用原生 net/tls 模块直接对话 SMTP 服务器（无第三方依赖）。
 * 支持 SSL（465 端口）和 STARTTLS（587 端口）。
 *
 * 认证方式：AUTH LOGIN（base64 用户名+密码，主流邮箱均支持）。
 */

import net from 'node:net';
import tls from 'node:tls';
import type { ChannelPlugin, ChannelMessage, ChannelSendResult } from './types';
import { formatMessagePlain } from './types';

interface SmtpConfig {
  host: string;
  port: string;
  user: string;
  pass: string;
  from: string;
  to: string;
}

/** 读一行（以 \r\n 结束）。 */
function readLine(socket: net.Socket | tls.TLSSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf-8');
      const idx = buf.indexOf('\r\n');
      if (idx >= 0) {
        const line = buf.slice(0, idx);
        socket.off('data', onData);
        socket.off('error', onError);
        resolve(line);
      }
    };
    const onError = (err: Error) => {
      socket.off('data', onData);
      reject(err);
    };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

async function expect(socket: net.Socket | tls.TLSSocket, code: string): Promise<string> {
  const line = await readLine(socket);
  if (!line.startsWith(code)) {
    throw new Error(`SMTP error: expected ${code}, got: ${line}`);
  }
  return line;
}

function sendCmd(socket: net.Socket | tls.TLSSocket, cmd: string): void {
  socket.write(cmd + '\r\n');
}

/** base64 编码（UTF-8 安全）。 */
function b64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64');
}

async function smtpSend(config: SmtpConfig, subject: string, body: string): Promise<void> {
  const port = parseInt(config.port) || 465;
  const useTLS = port === 465;
  const socket: net.Socket | tls.TLSSocket = useTLS
    ? tls.connect({ host: config.host, port, rejectUnauthorized: true })
    : net.createConnection({ host: config.host, port });

  try {
    // 等待连接
    await new Promise<void>((resolve, reject) => {
      socket.once('secureConnect', resolve);
      socket.once('connect', resolve);
      socket.once('error', reject);
    });

    await expect(socket, '220');
    sendCmd(socket, `EHLO sage`);

    // STARTTLS for port 587
    if (!useTLS) {
      // Read multiline EHLO response (250- lines until final 250 ...)
      let line = '';
      do {
        line = await readLine(socket);
      } while (line.startsWith('250-'));
      if (!line.startsWith('250 ')) throw new Error(`EHLO failed: ${line}`);

      sendCmd(socket, 'STARTTLS');
      const startTlsResp = await readLine(socket);
      if (!startTlsResp.startsWith('220')) throw new Error(`STARTTLS failed: ${startTlsResp}`);

      // Upgrade to TLS
      const tlsSocket = tls.connect({
        socket: socket as net.Socket,
        rejectUnauthorized: true,
      });
      await new Promise<void>((resolve, reject) => {
        tlsSocket.once('secureConnect', resolve);
        tlsSocket.once('error', reject);
      });
      // Replace socket with TLS socket for subsequent operations
      // We can't reassign the const, so we work on the original with a workaround.
      // Re-assign socket reference by closing and re-doing on the TLS socket.
      // To keep things simple, we call an inner function.
      await authAndSend(tlsSocket, config, subject, body);
    } else {
      // Port 465: read multiline EHLO response then authenticate directly
      let line = '';
      do {
        line = await readLine(socket);
      } while (line.startsWith('250-'));
      if (!line.startsWith('250 ')) throw new Error(`EHLO failed: ${line}`);
      await authAndSend(socket, config, subject, body);
    }
  } finally {
    socket.destroy();
  }
}

async function authAndSend(
  socket: net.Socket | tls.TLSSocket,
  config: SmtpConfig,
  subject: string,
  body: string,
): Promise<void> {
  // AUTH LOGIN
  sendCmd(socket, 'AUTH LOGIN');
  await expect(socket, '334');
  sendCmd(socket, b64(config.user));
  await expect(socket, '334');
  sendCmd(socket, b64(config.pass));
  await expect(socket, '235');

  // MAIL FROM / RCPT TO
  sendCmd(socket, `MAIL FROM:<${config.from}>`);
  await expect(socket, '250');
  sendCmd(socket, `RCPT TO:<${config.to}>`);
  await expect(socket, '250');
  sendCmd(socket, 'DATA');
  await expect(socket, '354');

  // 邮件正文
  const date = new Date().toUTCString();
  const encodedSubject = `=?UTF-8?B?${b64(subject)}?=`;
  const headers = [
    `From: ${config.from}`,
    `To: ${config.to}`,
    `Subject: ${encodedSubject}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: 8bit`,
    '',
  ].join('\r\n');
  const email = headers + body + '\r\n.\r\n';
  socket.write(email, 'utf-8');
  await expect(socket, '250');
  sendCmd(socket, 'QUIT');
}

export const emailChannel: ChannelPlugin = {
  type: 'email',
  label: '电子邮件',
  fields: [
    { key: 'host', label: 'SMTP 服务器', type: 'text', required: true, placeholder: 'smtp.gmail.com', defaultValue: 'smtp.gmail.com' },
    { key: 'port', label: '端口', type: 'number', required: true, placeholder: '465', defaultValue: '465', help: 'SSL=465, STARTTLS=587' },
    { key: 'user', label: '用户名', type: 'text', required: true, placeholder: 'you@gmail.com' },
    { key: 'pass', label: '密码 / 应用密码', type: 'password', required: true, placeholder: 'App Password', help: 'Gmail/163 等需使用应用专用密码' },
    { key: 'from', label: '发件人', type: 'email', required: true, placeholder: 'you@gmail.com' },
    { key: 'to', label: '收件人', type: 'email', required: true, placeholder: 'recipient@example.com' },
  ],
  validate(c) {
    if (!c.host || !c.port || !c.user || !c.pass || !c.from || !c.to) {
      return '请填写所有必填字段';
    }
    return null;
  },
  async send(c, message: ChannelMessage): Promise<ChannelSendResult> {
    try {
      const config = c as unknown as SmtpConfig;
      await smtpSend(config, message.title, formatMessagePlain(message));
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  },
  async test(c): Promise<ChannelSendResult> {
    return this.send(c, {
      title: 'Sage 测试邮件',
      content: '这是一封来自 Sage 定时任务系统的测试邮件。如果你收到了，说明邮件渠道配置正确！',
      taskName: '测试',
      timestamp: Date.now(),
    });
  },
};
