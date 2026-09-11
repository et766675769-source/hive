// 面板契约状态的 DOM 断言：真的打开页面，读渲染出来的文本。
export async function run({ send, evaluate, sleep }) {
  const board = process.env.MB_BOARD || 'http://127.0.0.1:8787';
  await send('Page.enable');
  await send('Page.navigate', { url: `${board}/?nostream=0` });
  await sleep(2500);

  const snapshot = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.member')].map((row) => ({
      id: row.dataset.agent,
      state: row.dataset.state,
      contract: row.dataset.contract || '',
      name: row.querySelector('.member__name')?.textContent || '',
      sub: row.querySelector('.member__sub')?.textContent || '',
      subAlert: Boolean(row.querySelector('.member__sub--alert')),
      subTitle: row.querySelector('.member__sub')?.getAttribute('title') || '',
      badges: [...row.querySelectorAll('.member__badges .pending')].map((b) => b.textContent.trim()),
    }));
    return {
      rows,
      count: document.querySelector('#onlineCount')?.textContent || '',
      countTitle: document.querySelector('#onlineCount')?.getAttribute('title') || '',
      railMeta: document.querySelector('#railMeta')?.textContent || '',
      noteText: document.querySelector('.roster__note')?.textContent || '',
    };
  })()`);

  const checks = [];
  const push = (name, ok, detail) => checks.push({ name, ok, detail });

  push('成员行渲染出来了', snapshot.rows.length > 0, `${snapshot.rows.length} 行`);
  push('每行带契约状态属性', snapshot.rows.every((row) => row.contract), snapshot.rows.map((r) => `${r.id}=${r.contract}`).join(', '));

  const withContractText = snapshot.rows.filter((row) =>
    /无待办|排队中|等回执|正在处理|没人取件|没回执|开始了没交付|作废未回应|需人工唤起/.test(row.sub),
  );
  push(
    '名字下面那行是契约状态（不是"在线"）',
    withContractText.length === snapshot.rows.length,
    snapshot.rows.map((r) => `${r.id}: ${r.sub.slice(0, 34)}`).join(' | '),
  );

  const notJustOnline = snapshot.rows.every((row) => !/^在线|^忙碌|^空闲/.test(row.sub.trim()));
  push('主信息不再以在线/忙碌开头', notJustOnline, snapshot.rows.map((r) => r.sub.slice(0, 20)).join(' | '));

  push('头部计数是"履行中/全部"', /^\d+\/\d+$/.test(snapshot.count.trim()), `${snapshot.count.trim()}（title: ${snapshot.countTitle.slice(0, 40)}）`);
  push('说明文字解释了契约优先', /契约状态/.test(snapshot.noteText), snapshot.noteText.trim().slice(0, 60));

  const alerts = snapshot.rows.filter((row) => row.subAlert);
  push(
    '有违约成员时主信息会变色',
    // 没有违约成员时这条不适用：只在存在 alert 契约时要求变色
    snapshot.rows.every((row) => !['not-fetched', 'no-ack', 'overdue'].includes(row.contract) || row.subAlert),
    alerts.map((row) => `${row.id}:${row.contract}`).join(', ') || '（本轮没有违约成员）',
  );

  // 抽屉模式（窄窗）下的排版回归：页脚与说明文字曾经叠在一起，看着像乱码。
  // 直接量盒子，别靠肉眼：任何两个可见文本块重叠超过 2px 就算不合格。
  await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 620, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${board}/?nostream=0&rail=open` });
  await sleep(2000);

  const layout = await evaluate(`(() => {
    const rail = document.querySelector('.rail');
    if (!rail) return { blocks: [], railScrolls: null, footPosition: '' };
    // 只比较 .rail 的**直接子块**：父子元素天然互相包含，比较它们没有意义；
    // 而"两层字叠在一起"这类 bug 一定发生在同级块之间。
    const blocks = [...rail.children]
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || rect.height === 0) return null;
        return {
          selector: '.' + (node.className || node.tagName).toString().split(' ').filter(Boolean).join('.'),
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
        };
      })
      .filter(Boolean);
    const foot = document.querySelector('.rail__foot');
    return {
      blocks,
      railScrolls: { scrollHeight: rail.scrollHeight, clientHeight: rail.clientHeight, overflowY: getComputedStyle(rail).overflowY },
      footPosition: foot ? getComputedStyle(foot).position : '',
      noteScrolls: (() => {
        const roster = document.querySelector('.roster');
        return roster ? getComputedStyle(roster).overflowY : '';
      })(),
    };
  })()`);

  const overlaps = [];
  for (let i = 0; i < layout.blocks.length; i += 1) {
    for (let j = i + 1; j < layout.blocks.length; j += 1) {
      const a = layout.blocks[i];
      const b = layout.blocks[j];
      const vertical = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      const horizontal = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      if (vertical > 2 && horizontal > 2) overlaps.push(`${a.selector} ∩ ${b.selector}（${Math.round(vertical)}px）`);
    }
  }
  push('抽屉模式下侧栏同级块不重叠', overlaps.length === 0, overlaps.join('；') || `${layout.blocks.length} 个同级块互不重叠`);
  push('页脚不再用 sticky 压在内容上', layout.footPosition !== 'sticky', `position=${layout.footPosition}`);
  push(
    '抽屉本身不滚动，改由名单区滚动',
    Boolean(layout.railScrolls) && layout.railScrolls.overflowY === 'hidden' && layout.noteScrolls === 'auto',
    `rail overflow-y=${layout.railScrolls ? layout.railScrolls.overflowY : '?'} / roster overflow-y=${layout.noteScrolls}`,
  );

  return { ok: checks.every((check) => check.ok), checks, snapshot };
}
