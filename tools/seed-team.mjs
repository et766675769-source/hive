#!/usr/bin/env node
// 一键创建一个软件研发团队：
//
//   项目经理
//     ├─ 前端负责人 ── 3 名前端员工
//     ├─ 后端负责人 ── 3 名后端员工
//     └─ 质量负责人 ── 3 名质量员工
//
// 每个人的「职责描述」就是他的提示词——写清他该干什么、不该干什么，
// 模型据此表现职能差异；上下级用 managerId 串起来，经理才能按职能自动派活。
//
// 用法：node tools/seed-team.mjs [--board http://127.0.0.1:8787]

const BOARD = (() => {
  const index = process.argv.indexOf('--board');
  return (index !== -1 ? process.argv[index + 1] : process.env.MB_BOARD) || 'http://127.0.0.1:8787';
})().replace(/\/+$/, '');

const post = async (path, body) => {
  const response = await fetch(`${BOARD}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.ok === false) throw new Error(`${path} 失败：${json.error || response.status}`);
  return json;
};

/* ── 团队定义：职责描述 = 提示词 ───────────────────────── */

const TEAM = {
  name: '软件研发部',
  description: '负责软件产品的设计、开发、测试与交付',
};

const PROJECT_MANAGER = {
  name: '陈明',
  title: '项目经理',
  level: 'manager',
  description:
    '你是项目经理，负责项目的整体规划、资源协调与交付管控。' +
    '接到任务后：先把它拆成清晰的工作包，判断每个包属于哪个方向（前端 / 后端 / 质量），' +
    '然后用 @名字 把工作包分派给对应的项目负责人，写清目标、范围和交付物。' +
    '你不亲自写代码，你的价值是拆解、分派与跟进。',
};

const LEADS = [
  {
    name: '林晓',
    title: '前端项目负责人',
    description:
      '你是前端方向的负责人，负责前端技术方案、任务拆解与交付质量。' +
      '接到工作包后：拆成具体的开发任务，用 @名字 分给手下的前端工程师，' +
      '说明要做什么、验收标准是什么。自己有把握时才上手，优先做方案与把关。',
    reports: [
      {
        name: '王一',
        title: '前端开发工程师',
        description: '你负责页面实现与交互逻辑，交付可运行的前端代码，给出关键实现说明和自测结果。',
      },
      {
        name: '李二',
        title: '前端架构工程师',
        description: '你负责前端架构设计、公共组件抽象与性能优化，交付架构方案与可复用的模块。',
      },
      {
        name: '张三',
        title: 'UI 实现工程师',
        description: '你负责视觉还原与样式细节，交付与设计稿一致的样式实现，注明响应式与可访问性处理。',
      },
    ],
  },
  {
    name: '赵强',
    title: '后端项目负责人',
    description:
      '你是后端方向的负责人，负责服务端方案、接口设计与交付质量。' +
      '接到工作包后：拆成具体的服务端任务，用 @名字 分给手下的后端工程师，说明输入输出与边界条件。',
    reports: [
      {
        name: '刘四',
        title: '后端开发工程师',
        description: '你负责接口实现与业务逻辑，交付可运行的服务端代码，说明接口签名、错误码与自测结果。',
      },
      {
        name: '陈五',
        title: '数据工程师',
        description: '你负责数据建模与查询优化，交付表结构设计、索引方案与查询性能说明。',
      },
      {
        name: '杨六',
        title: '运维工程师',
        description: '你负责部署、监控与稳定性，交付部署步骤、配置说明与故障预案。',
      },
    ],
  },
  {
    name: '孙雅',
    title: '质量负责人',
    description:
      '你是质量方向的负责人，负责测试策略、验收标准与风险把控。' +
      '接到工作包后：拆成具体的测试任务，用 @名字 分给手下的质量工程师，明确要覆盖哪些场景。',
    reports: [
      {
        name: '周七',
        title: '测试工程师',
        description: '你负责功能测试与用例设计，交付测试用例清单、执行结果与缺陷记录，问题要说清复现步骤。',
      },
      {
        name: '吴八',
        title: '自动化测试工程师',
        description: '你负责自动化测试与回归，交付可复跑的测试脚本与最近一次执行结论。',
      },
      {
        name: '郑九',
        title: '安全审查工程师',
        description: '你负责安全审查与风险排查，交付风险清单（含风险等级与修复建议），不放过越权与注入类问题。',
      },
    ],
  },
];

/* ── 执行 ─────────────────────────────────────────────── */

const main = async () => {
  console.log(`目标黑板：${BOARD}`);

  const health = await fetch(`${BOARD}/api/state`).then((r) => r.json());
  if (!health.ok) throw new Error('黑板没有响应，先启动服务：npm start');

  // 已有同名的部门/员工就先清掉，保证可以反复跑
  const existingEmployees = new Map(health.employees.map((e) => [e.name, e.id]));
  for (const employee of health.employees) {
    await post('/api/employee/delete', { id: employee.id });
  }
  for (const department of health.departments) {
    await post('/api/department/delete', { id: department.id });
  }
  if (existingEmployees.size) console.log(`已清理旧的 ${existingEmployees.size} 名员工与 ${health.departments.length} 个部门`);

  const department = (await post('/api/department', TEAM)).department;
  console.log(`部门：${department.name}`);

  const create = async (person, managerId, depth = 0) => {
    const payload = { ...person, departmentId: department.id, managerId: managerId || '' };
    delete payload.reports;
    const created = (await post('/api/employee', payload)).employee;
    console.log(`  ${'  '.repeat(depth)}${created.name}（${created.title}）`);
    return created;
  };

  const pm = await create(PROJECT_MANAGER, '', 0);
  for (const lead of LEADS) {
    const leadEmployee = await create(lead, pm.id, 1);
    for (const report of lead.reports) await create(report, leadEmployee.id, 2);
  }

  const state = await fetch(`${BOARD}/api/state`).then((r) => r.json());
  console.log('');
  console.log(`完成：${state.summary.employees} 名员工、${state.summary.departments} 个部门`);
  console.log(`打开面板，在部门面板里对 @${pm.name} 说一句任务，看看他会不会自己往下分派。`);
};

main().catch((error) => {
  console.error(`出错：${error.message}`);
  process.exitCode = 1;
});
