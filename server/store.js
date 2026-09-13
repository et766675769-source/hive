// 蜂群 HIVE · 数据层
//
// 一切都在本机 data/ 下，零依赖（只用 Node 内置模块）：
//   settings.json         全局 API 通道（Key / 接口地址 / 默认模型）
//   org.json              部门（departments）+ 员工（employees）
//   projects.json         项目（一个项目可由多个部门共同完成）
//   threads/<mode>/<id>.jsonl   对话（追加式，只增不改）
//
// 三种线程模式（mode）：
//   department/<部门 id>   部门内部沟通面板
//   project/<项目 id>      项目相关沟通面板
//   employee/<员工 id>     单个员工的工作进程面板

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_SETTINGS = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  // 推理等级：default（不传，用接口自己的默认）/ off（关掉思考）/ low / high / max
  reasoning: 'default',
  // 按职级分配模型：每个职级一个通道，models 可以填多个（同职级的人轮着用）。
  // baseUrl / apiKey 留空 = 用上面的默认通道；填了就用这个职级自己的（比如普通员工走免费厂商）。
  levelChannels: {
    manager: { models: ['deepseek-v4-pro'], baseUrl: '', apiKey: '' },
    lead: { models: ['deepseek-flash'], baseUrl: '', apiKey: '' },
    worker: { models: [], baseUrl: '', apiKey: '' },
  },
  onboarded: false, // 是否走完首次引导
  updatedAt: '',
};

export const REASONING_LEVELS = ['default', 'off', 'low', 'high', 'max'];

/** 三个职级：P3 最高（经理）→ P2（项目负责人）→ P1（普通员工）。 */
export const LEVELS = ['manager', 'lead', 'worker'];
export const LEVEL_RANKS = { manager: 'P3', lead: 'P2', worker: 'P1' };
export const LEVEL_LABELS = { manager: '经理', lead: '项目负责人', worker: '普通员工' };
export const LEVEL_CHANNEL_KEYS = ['manager', 'lead', 'worker'];

export const THREAD_MODES = ['department', 'project', 'employee'];

/** 稳定的小哈希：同一个员工每次分到同一个模型（同职级里轮着用）。 */
function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) % 1000003;
  return hash;
}

export class Store {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.settingsFile = path.join(dataDir, 'settings.json');
    this.orgFile = path.join(dataDir, 'org.json');
    this.projectsFile = path.join(dataDir, 'projects.json');
    this.threadsDir = path.join(dataDir, 'threads');
    fs.mkdirSync(this.threadsDir, { recursive: true });
  }

  #readJson(file, fallback) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  #writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
  }

  /* ── 全局 API 通道 ─────────────────────────────────────── */

  readSettings() {
    const stored = this.#readJson(this.settingsFile, {});
    const settings = { ...DEFAULT_SETTINGS, ...stored };
    // levelChannels 要逐职级合并，不然老配置里缺的那一档会整个丢掉
    const merged = {};
    for (const key of LEVEL_CHANNEL_KEYS) {
      merged[key] = { ...DEFAULT_SETTINGS.levelChannels[key], ...(stored.levelChannels?.[key] || {}) };
    }
    settings.levelChannels = merged;
    return settings;
  }

  writeSettings(patch) {
    const next = { ...this.readSettings(), ...patch, updatedAt: new Date().toISOString() };
    this.#writeJson(this.settingsFile, next);
    return next;
  }

  /**
   * 某个员工实际使用的通道，优先级：
   *   员工自己填的 → 他这个职级的通道（P3/P2/P1）→ 全局默认通道。
   * 职级的 models 可以填多个，同一个职级的人按员工 id 稳定地轮着用（同一个人每次都拿同一个）。
   */
  channelFor(employee = {}) {
    const settings = this.readSettings();
    const level = LEVELS.includes(employee.level) ? employee.level : 'worker';
    const channel = settings.levelChannels?.[level] || {};
    const models = (Array.isArray(channel.models) ? channel.models : [])
      .map((name) => String(name || '').trim())
      .filter(Boolean);

    const ownModel = String(employee.model || '').trim();
    const picked = models.length ? models[hashString(employee.id || employee.name || '') % models.length] : '';

    return {
      apiKey: String(employee.apiKey || '').trim() || String(channel.apiKey || '').trim() || String(settings.apiKey || '').trim(),
      baseUrl: String(employee.baseUrl || '').trim() || String(channel.baseUrl || '').trim() || String(settings.baseUrl || '').trim(),
      model: ownModel || picked || String(settings.model || '').trim(),
      reasoning: String(employee.reasoning || '').trim() || String(settings.reasoning || '').trim() || 'default',
      level,
      rank: LEVEL_RANKS[level],
      levelModelCount: models.length,   // 这个职级配了几个模型可选
      levelModel: picked,               // 按职级分到的模型（没配就是空）
      inherited: !String(employee.apiKey || '').trim(),
    };
  }

  /* ── 组织：部门 + 员工 ─────────────────────────────────── */

  readOrg() {
    const org = this.#readJson(this.orgFile, {});
    return {
      departments: Array.isArray(org.departments) ? org.departments : [],
      employees: Array.isArray(org.employees) ? org.employees : [],
    };
  }

  writeOrg(org) {
    this.#writeJson(this.orgFile, {
      departments: org.departments || [],
      employees: org.employees || [],
      updatedAt: new Date().toISOString(),
    });
    return org;
  }

  /* ── 项目 ──────────────────────────────────────────────── */

  readProjects() {
    const data = this.#readJson(this.projectsFile, {});
    return { projects: Array.isArray(data.projects) ? data.projects : [] };
  }

  writeProjects(data) {
    this.#writeJson(this.projectsFile, {
      projects: data.projects || [],
      updatedAt: new Date().toISOString(),
    });
    return data;
  }

  /* ── 对话线程（追加式，只增不改）───────────────────────── */

  threadFile(mode, id) {
    const safeMode = THREAD_MODES.includes(mode) ? mode : 'department';
    const safeId = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(this.threadsDir, safeMode, `${safeId}.jsonl`);
  }

  readThread(mode, id, { limit = 300 } = {}) {
    let text = '';
    try {
      text = fs.readFileSync(this.threadFile(mode, id), 'utf8');
    } catch {
      return [];
    }
    const lines = text.split(/\r?\n/).filter(Boolean);
    const out = [];
    for (const line of lines.slice(-limit)) {
      try {
        out.push(JSON.parse(line));
      } catch {
        /* 坏行跳过，不因为一行脏数据丢掉整条线程 */
      }
    }
    return out;
  }

  appendMessage(mode, id, message) {
    const file = this.threadFile(mode, id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(message)}\n`, 'utf8');
    return message;
  }

  /**
   * 清空一条线程的全部记录。
   * 先把原文件改名留档到 data/threads/_cleared/<模式>/<id>-<时间>.jsonl（误删可找回），
   * 再删掉正式文件。返回这次清掉了多少条。
   */
  clearThread(mode, id) {
    const file = this.threadFile(mode, id);
    const messages = this.readThread(mode, id, { limit: 100000 });
    if (!fs.existsSync(file)) return { cleared: 0, backup: '' };
    const backupDir = path.join(this.threadsDir, '_cleared', THREAD_MODES.includes(mode) ? mode : 'department');
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(backupDir, `${path.basename(file, '.jsonl')}-${stamp}.jsonl`);
    try {
      fs.renameSync(file, backup);
    } catch {
      fs.writeFileSync(backup, fs.readFileSync(file));
      fs.unlinkSync(file);
    }
    return { cleared: messages.length, backup };
  }

  /** 线程里最后一条留言（左侧栏和项目卡片用它显示摘要）。 */
  lastMessage(mode, id) {
    const messages = this.readThread(mode, id, { limit: 1 });
    return messages[messages.length - 1] || null;
  }

  /* ── 统计（页眉/左侧栏用）──────────────────────────────── */

  summary() {
    const { departments, employees } = this.readOrg();
    const { projects } = this.readProjects();
    return {
      departments: departments.length,
      employees: employees.length,
      projects: projects.length,
      activeProjects: projects.filter((p) => p.status === '进行中').length,
    };
  }
}
