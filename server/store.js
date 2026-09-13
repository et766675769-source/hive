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
  onboarded: false, // 是否走完首次引导
  updatedAt: '',
};

export const THREAD_MODES = ['department', 'project', 'employee'];

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
    return { ...DEFAULT_SETTINGS, ...this.#readJson(this.settingsFile, {}) };
  }

  writeSettings(patch) {
    const next = { ...this.readSettings(), ...patch, updatedAt: new Date().toISOString() };
    this.#writeJson(this.settingsFile, next);
    return next;
  }

  /** 某个员工实际使用的通道：员工自己填的优先，空则回落到全局默认。 */
  channelFor(employee = {}) {
    const settings = this.readSettings();
    return {
      apiKey: String(employee.apiKey || '').trim() || String(settings.apiKey || '').trim(),
      baseUrl: String(employee.baseUrl || '').trim() || String(settings.baseUrl || '').trim(),
      model: String(employee.model || '').trim() || String(settings.model || '').trim(),
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
