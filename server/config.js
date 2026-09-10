// Message Board · 配置加载
//
// 事实源：仓库根目录的 board.config.json（可用 MB_CONFIG 指向别的文件）。
// 命令行 / 环境变量覆盖优先于配置文件，便于 CI 与临时试跑。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripBom } from './protocol.js';

/** 仓库根目录（server/ 的上一级） */
export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const FALLBACK_AGENTS = [
  {
    id: 'human',
    name: 'Human',
    monogram: 'H',
    platform: 'Human',
    title: '人类主控',
    mission: '设定目标、拍板决策、最终验收',
    skills: '',
    constraints: '',
    channel: 'http',
    kind: 'human',
  },
];

const FALLBACK_ACK_TOKENS = ['收到', '好的', 'ok', 'OK', 'roger', '+1'];

/**
 * 读取并归一化配置。
 * @param {{ host?: string, port?: number, dataDir?: string, token?: string }} [overrides]
 */
export function loadConfig(overrides = {}) {
  const configFile = process.env.MB_CONFIG || path.join(ROOT, 'board.config.json');

  let raw = {};
  if (fs.existsSync(configFile)) {
    try {
      raw = JSON.parse(stripBom(fs.readFileSync(configFile, 'utf8')));
    } catch (err) {
      throw new Error(`board.config.json 解析失败：${err.message}`);
    }
  }

  const rawBoard = raw.board || {};
  const rawPresence = raw.presence || {};
  const rawGuards = raw.guards || {};

  const board = {
    name: rawBoard.name || 'Message Board',
    nameZh: rawBoard.nameZh || '留言板',
    tagline: rawBoard.tagline || '本地多 AI 协作黑板',
    protocol: rawBoard.protocol || 'messageboard.protocol.v1',
    host: overrides.host || process.env.MB_HOST || rawBoard.host || '127.0.0.1',
    port: Number(overrides.port || process.env.MB_PORT || rawBoard.port || 8787),
    dataDir: overrides.dataDir || process.env.MB_DATA_DIR || rawBoard.dataDir || 'data',
    historyInMemory: Number(rawBoard.historyInMemory || 5000),
  };

  const presence = {
    heartbeatTtlSeconds: Number(rawPresence.heartbeatTtlSeconds || 45),
    sweepSeconds: Number(rawPresence.sweepSeconds || 5),
    staleMultiplier: Number(rawPresence.staleMultiplier || 6),
  };

  const guards = {
    rejectSuspectedSecrets: rawGuards.rejectSuspectedSecrets !== false,
    flagAcknowledgementOnly: rawGuards.flagAcknowledgementOnly !== false,
    acknowledgementTokens: Array.isArray(rawGuards.acknowledgementTokens) && rawGuards.acknowledgementTokens.length
      ? rawGuards.acknowledgementTokens
      : FALLBACK_ACK_TOKENS,
  };

  const agents = Array.isArray(raw.agents) && raw.agents.length ? raw.agents : FALLBACK_AGENTS;
  const normalizedAgents = agents.map((agent, index) => ({
    id: String(agent.id || `agent-${index + 1}`).toLowerCase(),
    name: agent.name || agent.id || `Agent ${index + 1}`,
    monogram: agent.monogram || String(agent.name || agent.id || '?').trim().charAt(0).toUpperCase(),
    platform: agent.platform || '',
    title: agent.title || '',
    mission: agent.mission || '',
    skills: agent.skills || '',
    constraints: agent.constraints || '',
    channel: agent.channel || 'http',
    kind: agent.kind || 'ai',
  }));

  const seen = new Set();
  for (const agent of normalizedAgents) {
    if (seen.has(agent.id)) throw new Error(`board.config.json 中 agent id 重复：${agent.id}`);
    seen.add(agent.id);
  }

  const dataDir = path.isAbsolute(board.dataDir) ? board.dataDir : path.join(ROOT, board.dataDir);

  return {
    root: ROOT,
    configFile,
    board: { ...board, dataDir },
    presence,
    guards,
    agents: normalizedAgents,
    agentsById: new Map(normalizedAgents.map((agent) => [agent.id, agent])),
    token: overrides.token || process.env.MB_TOKEN || '',
  };
}
