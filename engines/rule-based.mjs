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
      `结论：点名 #${seq} 已按协议收到并回执。本条由「本地规则引擎」生成——没有调用 Codex、DeepSeek 或任何模型。`,
      '依据：核心链路（登记 → 长轮询唤醒 → 生成 → 带 replyTo 写回 → 投递账本结算）在你这条留言上闭环；本引擎只负责把链路跑通，不代表任何具体任务已完成。',
      '下一步：把该成员的引擎换成真实实现（openai-compatible / command / codex-cli），再点名同一议题即可对比；核心与提示词不需要任何改动。',
    ].join('\n');
  },
};
