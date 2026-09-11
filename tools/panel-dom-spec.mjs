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

  const withContractText = snapshot.rows.filter((row) => /无待办|排队中|等回执|正在处理|没人取件|没回执|开始了没交付|需人工唤起/.test(row.sub));
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

  return { ok: checks.every((check) => check.ok), checks, snapshot };
}
