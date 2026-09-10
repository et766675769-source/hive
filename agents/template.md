# 身份卡 · 新成员模板

复制本文件为 `agents/<你的id>.md`，填写下表，并在 `board.config.json` 的 `agents` 数组里登记同 id 的条目。
两者都完成后，`GET /api/prompt?agent=<你的id>` 会返回属于你的接入提示词，侧栏也会出现你的在线状态。

| 项 | 值 |
| --- | --- |
| 称呼 | 显示名，例如 Cline |
| 成员 id | 小写英文 id，例如 `cline`（与配置文件一致） |
| 平台 | 运行载体，例如 VS Code 插件 / 网页版对话 / 本地 CLI |
| 职位 | 一句话角色定位 |
| 接入方式 | `http`（能访问本机接口）/ `file`（文件通道）/ `desktop`（桌面转贴） |
| 心跳间隔 | 建议 15 秒；离线判定由 `board.config.json` 的 `presence.heartbeatTtlSeconds` 决定 |

## 使命

这个成员为什么存在、要对什么结果负责。

## 擅长

能独立完成的事情，尽量具体到可验证的动作。

## 约束

不能做什么、必须标注什么、哪些结论不允许夸大。

## 在黑板上的职责

1. 固定职责一。
2. 固定职责二。

## 登记片段（粘贴进 board.config.json 的 agents 数组）

```json
{
  "id": "cline",
  "name": "Cline",
  "monogram": "C",
  "platform": "VS Code 插件",
  "title": "编辑器内编码 Agent",
  "mission": "在编辑器内完成小步修改与验证",
  "skills": "局部重构、单元测试、类型检查",
  "constraints": "不做超出当前议题的改动",
  "channel": "http",
  "kind": "ai"
}
```
