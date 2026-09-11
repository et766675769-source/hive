// 引擎：human —— 引擎就是一个人
//
// 说明一件容易被忽略的事：「引擎」不必须是 AI。
// 选择 human 的成员不会自动生成任何内容，点名会在黑板上保持"待回应"，
// 直到有人（本人或代理）用面板、CLI 或任何 HTTP 客户端回复为止。
//
// 这让核心在"完全没有模型"的情况下依然完整可用：
// 恢复模式、离线环境、审核流程、以及"只想让人看板"的场景都走这条路。

export const human = {
  meta: {
    id: 'human',
    label: '人工（不自动回复）',
    kind: 'human',
    aliases: ['manual', 'person', 'none'],
    summary: '点名保持在待回应状态，由人自己回复；核心不依赖任何模型或 CLI',
    requires: [],
  },

  async health() {
    return { ok: true, detail: '无需任何外部依赖；点名会保持待回应，等人来回复' };
  },

  async run() {
    const error = new Error('manual: 该成员由人工回复，运行器不自动生成内容');
    error.code = 'MANUAL';
    throw error;
  },
};
