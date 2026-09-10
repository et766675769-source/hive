// Message Board · 协议层
//
// 这里只放「协议规定」而非实现细节：留言字段、状态枚举、@ 提及解析、
// 敏感信息拦截、空话回复识别、本地时区时间戳。
//
// 协议名：messageboard.protocol.v1

export const SCHEMA = 'messageboard.protocol.v1';

/** 议题状态（与旧协议一致：进行中 / 待确认 / 已解决，新增阻塞） */
export const STATUSES = ['进行中', '待确认', '已解决', '阻塞'];

/** 留言类型 */
export const KINDS = ['message', 'reply', 'decision', 'evidence', 'handoff', 'notice'];

/** 在线状态 */
export const PRESENCE_STATES = ['online', 'busy', 'idle'];

const MENTION_RE = /@([A-Za-z0-9][A-Za-z0-9_-]{0,31})/g;

/**
 * 解析正文中的 @提及，只保留名册内存在的成员 id。
 * 名册外的 @xxx 会被忽略（但正文原样保留）。
 */
export function parseMentions(text, agentIds) {
  const known = new Set(agentIds.map((id) => String(id).toLowerCase()));
  const found = new Set();
  for (const match of String(text || '').matchAll(MENTION_RE)) {
    const id = match[1].toLowerCase();
    if (known.has(id)) found.add(id);
  }
  return [...found];
}

const SECRET_PATTERNS = [
  { label: 'OpenAI/DeepSeek 风格的 sk- 密钥', re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { label: 'GitHub 令牌', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { label: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'Bearer 令牌', re: /\bBearer\s+[A-Za-z0-9._-]{20,}/ },
  {
    label: 'key=value 形式的凭据',
    re: /(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9._\-/+]{16,}/i,
  },
];

/** 命中则返回可读的密钥类型；用于拒绝把凭据写上黑板。 */
export function findSuspectedSecret(text) {
  const value = String(text || '');
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.re.test(value)) return pattern.label;
  }
  return null;
}

/** 去掉 @提及与标点后的「实义词」，用于判断是否只是空话回复。 */
export function substanceOf(text) {
  return String(text || '')
    .replace(MENTION_RE, '')
    .replace(/[\s\u3000。，、,.!！?？~～;；:：\-—_*"'“”‘’()（）[\]{}]/g, '')
    .toLowerCase();
}

/** 仅由「收到 / 好的 / ok」一类空话组成时返回 true。 */
export function isAcknowledgementOnly(text, tokens = []) {
  const substance = substanceOf(text);
  if (!substance) return true;
  return tokens.some((token) => substance === String(token).replace(/\s/g, '').toLowerCase());
}

/** 去掉 UTF-8 BOM：Windows 上的记事本 / PowerShell 很容易写出带 BOM 的文件。 */
export function stripBom(text) {
  return String(text || '').replace(/^\uFEFF/, '');
}

/** 本地时区 ISO8601（含 +08:00 这类偏移），与旧黑板心跳格式保持一致。 */
export function localIso(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** 人类可读的本地时间戳（用于黑板镜像与界面）。 */
export function localDisplay(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`;
}

/**
 * 校验一条入站留言。
 * 返回 { ok, code, error, flags, mentions, text }；不抛异常，交给调用方决定响应码。
 */
export function validateMessage(payload, { agentsById, guards }) {
  const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
  if (!text) return { ok: false, code: 'EMPTY_TEXT', error: '留言正文不能为空。' };
  if (text.length > 20000) return { ok: false, code: 'TEXT_TOO_LONG', error: '单条留言上限 20000 字符。' };

  const agentId = String(payload?.agent || '').toLowerCase();
  if (!agentId) return { ok: false, code: 'MISSING_AGENT', error: '缺少 agent 字段（留言者 id）。' };
  if (!agentsById.has(agentId)) {
    return {
      ok: false,
      code: 'UNKNOWN_AGENT',
      error: `名册中没有成员 ${agentId}；请在 board.config.json 的 agents 中登记后再发言。`,
    };
  }

  const secret = guards.rejectSuspectedSecrets ? findSuspectedSecret(text) : null;
  if (secret) {
    return { ok: false, code: 'SUSPECTED_SECRET', error: `正文疑似包含${secret}，黑板禁止记录任何凭据。` };
  }

  const topic = payload?.topic ? String(payload.topic).trim().slice(0, 32) : null;
  const status = payload?.status ? String(payload.status).trim() : null;
  if (status && !STATUSES.includes(status)) {
    return { ok: false, code: 'BAD_STATUS', error: `status 必须是 ${STATUSES.join(' / ')} 之一。` };
  }

  const kind = payload?.kind ? String(payload.kind).trim() : 'message';
  if (!KINDS.includes(kind)) {
    return { ok: false, code: 'BAD_KIND', error: `kind 必须是 ${KINDS.join(' / ')} 之一。` };
  }

  const mentions = parseMentions(text, [...agentsById.keys()]).filter((id) => id !== agentId);

  const flags = [];
  if (guards.flagAcknowledgementOnly && isAcknowledgementOnly(text, guards.acknowledgementTokens)) {
    flags.push('ACK_ONLY');
  }

  return { ok: true, text, agentId, topic, status, kind, mentions, flags };
}
