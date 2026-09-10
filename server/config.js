// Message Board · 成员配置
//
// board.config.json 只保留「黑板自身」的配置与可选的预置成员。
// 成员默认是空的：AI 通过 POST /api/join 自述身份即完成登记（见 registry.js）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripBom } from './protocol.js';

/** 仓库根目录（server/ 的上一级） */
export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const DEFAULT_LOCAL_OPERATOR = {
  id: 'local',
  name: '本地',
  monogram: '本',
  platform: '本机',
  title: '本机操作员',
  mission: '在本机黑板界面直接留言，不作为成员出现在名册中',
  skills: '',
  constraints: '不写凭据；留言同样只追加',
  channel: 'http',
  kind: 'operator',
  hidden: true,
};

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
  const rawDelivery = raw.delivery || {};
  const overrideDelivery = overrides.delivery || {};

  const board = {
    name: rawBoard.name || 'Message Board',
    nameZh: rawBoard.nameZh || '留言板',
    tagline: rawBoard.tagline || '本地多 AI 协作黑板',
    protocol: rawBoard.protocol || 'messageboard.protocol.v1',
    host: overrides.host || process.env.MB_HOST || rawBoard.host || '127.0.0.1',
    port: Number(overrides.port || process.env.MB_PORT || rawBoard.port || 8787),
    dataDir: overrides.dataDir || process.env.MB_DATA_DIR || rawBoard.dataDir || 'data',
    historyInMemory: Number(rawBoard.historyInMemory || 5000),
    openJoin: rawBoard.openJoin !== false,
  };

  const presence = {
    heartbeatTtlSeconds: Number(rawPresence.heartbeatTtlSeconds || 45),
    sweepSeconds: Number(rawPresence.sweepSeconds || 5),
    staleMultiplier: Number(rawPresence.staleMultiplier || 6),
  };

  // 投递租约：送达/处理中的 deadline，超时回收重投
  const delivery = {
    leaseSeconds: Number(overrideDelivery.leaseSeconds || rawDelivery.leaseSeconds || 180),
    maxAttempts: Number(overrideDelivery.maxAttempts || rawDelivery.maxAttempts || 2),
    sweepSeconds: Number(overrideDelivery.sweepSeconds || rawDelivery.sweepSeconds || 5),
    // 启动恢复：把历史上"被点名但没有实质回复"的留言重新放回投递队列
    backfillOnStart: (overrideDelivery.backfillOnStart ?? rawDelivery.backfillOnStart) !== false,
    backfillLimit: Number(overrideDelivery.backfillLimit || rawDelivery.backfillLimit || 3),
  };

  const guards = {
    rejectSuspectedSecrets: rawGuards.rejectSuspectedSecrets !== false,
    flagAcknowledgementOnly: rawGuards.flagAcknowledgementOnly !== false,
    acknowledgementTokens: Array.isArray(rawGuards.acknowledgementTokens) && rawGuards.acknowledgementTokens.length
      ? rawGuards.acknowledgementTokens
      : ['收到', '好的', '好', '明白', '了解', '知悉', 'ok', 'OK', 'Ok', 'roger', '+1', '同意', '已阅'],
  };

  // 预置成员：默认留空。需要固定成员时再写进 board.config.json 的 agents 数组。
  const presets = Array.isArray(raw.agents) ? raw.agents.filter((agent) => agent && agent.id) : [];
  const localOperator = raw.localOperator === null
    ? null
    : { ...DEFAULT_LOCAL_OPERATOR, ...(raw.localOperator || {}) };

  const dataDir = path.isAbsolute(board.dataDir) ? board.dataDir : path.join(ROOT, board.dataDir);

  return {
    root: ROOT,
    configFile,
    board: { ...board, dataDir },
    presence,
    delivery,
    guards,
    presets,
    localOperator,
    token: overrides.token || process.env.MB_TOKEN || '',
  };
}
