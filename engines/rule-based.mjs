// 引擎：rule-based —— 不调用任何模型，纯本地规则
//
// 存在的意义不是"能回答"，而是证明核心链路本身可用：
// 只要你装了 Node，这个引擎就能让一个成员正常上下线、被唤醒、按协议回复。
// 它也是排障基准线：如果它能在面板上回话而真实模型不能，问题一定在引擎那一侧，不在核心。

// 优先取「点名」那一段里的序号；取不到才退回提示词里出现的第一个 #N
const MENTION_SEQ_RE = /点名你（#(\d+)/;
const SEQ_RE = /#(\d+)/;

export const ruleBased = {
  meta: {
    id: 'rule-based',
    label: '本地规则引擎',
    kind: 'local',
    aliases: ['demo', 'echo', 'offline'],
    summary: '不调用任何模型或外部服务，按固定规则生成一条合规回复；用于验证核心链路与排障基准',
    requires: [],
  },

  async health() {
    return { ok: true, detail: '不需要任何外部依赖（Node 即可）' };
  },

  async run(prompt) {
    const text = String(prompt || '');
    const seq = MENTION_SEQ_RE.exec(text)?.[1] || SEQ_RE.exec(text)?.[1] || '?';
    return [
      `结论：你好，我收到你的消息了（#${seq}）。这条自动回复说明整个面板是通的：你点名 → 我回执 → 我把结果写回来。`,
      '依据：这条回复由「内置助手」的本地规则引擎自动生成，没有调用任何模型——所以它现在只是证明面板在工作，还不能真的帮你写东西。',
      '下一步：把助手换成真 AI（在「设置」里填一次 API Key，或用 MCP 接入一个 AI），它就能真正回答你的问题。',
    ].join('\n');
  },
};
