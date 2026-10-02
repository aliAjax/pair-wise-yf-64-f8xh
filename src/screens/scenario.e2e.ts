/**
 * 端到端场景：模拟一次网络抖动的会议跟播，跑完整条时序并在末尾断言两屏一致。
 * 运行：npx tsx src/screens/scenario.e2e.ts
 */
import {
  createScreens,
  ensureScreenRooms,
  migrateScreens,
  appendFeedEvent,
  livePush,
  screenOffline,
  screenReconnect,
  screenPause,
  tickScreen,
  reconcileBoth,
  publishRevision
} from './simulation';

const feedByRoom: Record<string, import('./engine').FeedEvent[]> = { hall: [] };
const seqByRoom: Record<string, number> = { hall: 0 };
let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? '✅' : '❌'} ${name}`);
  if (!cond) failures++;
}

function push(text: string, revision: number, opts: { captionId?: string; dup?: boolean } = {}) {
  const event = appendFeedEvent(feedByRoom, seqByRoom, 'hall', {
    captionId: opts.captionId ?? 'cap-1',
    speechId: 'sp-1',
    language: '中文',
    interpreter: '周雨',
    text,
    revision
  });
  livePush(screens, 'hall', event, { duplicate: opts.dup });
  return event;
}

function drain(ticks = 50) {
  for (let i = 0; i < ticks; i++) {
    tickScreen(screens.primary, 'hall');
    tickScreen(screens.backup, 'hall');
  }
}

// 1) 旧数据升级：厅里已保存 cap-1 v2，两块屏无游标 → 从最新版起步
feedByRoom.hall.push(
  { seq: 1, captionId: 'cap-1', speechId: 'sp-1', language: '中文', interpreter: '周雨', text: '旧v1', revision: 1, at: new Date().toISOString() },
  { seq: 2, captionId: 'cap-1', speechId: 'sp-1', language: '中文', interpreter: '周雨', text: '旧v2', revision: 2, at: new Date().toISOString() }
);
seqByRoom.hall = 2;
const screens = createScreens();
ensureScreenRooms(screens, ['hall']);
migrateScreens(screens, feedByRoom);
check('迁移后两屏游标=已保存最新版 v2', screens.primary.rooms.hall.cursors['cap-1'] === 2 && screens.backup.rooms.hall.cursors['cap-1'] === 2);
check('迁移后不重播历史（已播为空）', screens.primary.rooms.hall.played.length === 0);

// 2) 备屏断网；厅内推送 cap-1 v3、cap-2 v1
screenOffline(screens.backup, 'hall');
push('修订v3', 3);
push('第二句', 1, { captionId: 'cap-2' });
drain();
check('主屏在线播到 cap-1 v3 与 cap-2 v1', screens.primary.rooms.hall.cursors['cap-1'] === 3 && screens.primary.rooms.hall.cursors['cap-2'] === 1);
check('备屏断网期间啥也没播', screens.backup.rooms.hall.played.length === 0);

// 3) 主屏主持人暂停本屏；期间新到 cap-2 v2 留在主屏待播
screenPause(screens.primary, 'hall', true);
push('第二句修订', 2, { captionId: 'cap-2' });
tickScreen(screens.primary, 'hall');
check('主屏暂停期间不播，修订留在待播', screens.primary.rooms.hall.pending.some((e) => e.captionId === 'cap-2' && e.revision === 2));

// 4) 备屏重连：按 seq 补齐 3 条（cap-1 v3、cap-2 v1、cap-2 v2）
const filled = screenReconnect(screens.backup, 'hall', feedByRoom.hall);
check('备屏重连补齐 3 条', filled.length === 3);
check('补齐进入 catch-up', screens.backup.rooms.hall.catchingUp === true);
drain();
check('备屏补齐后播到最新（cap-1 v3、cap-2 v2）', screens.backup.rooms.hall.cursors['cap-1'] === 3 && screens.backup.rooms.hall.cursors['cap-2'] === 2);

// 5) 主屏恢复 → 从暂停点（cap-2 v2）接着播
screenPause(screens.primary, 'hall', false);
drain();
check('主屏恢复后播到 cap-2 v2', screens.primary.rooms.hall.cursors['cap-2'] === 2);

// 6) 重复推送：cap-2 v2 再推一遍（模拟会场网络重发），每屏只播一次
const dup = feedByRoom.hall.find((e) => e.captionId === 'cap-2' && e.revision === 2)!;
livePush(screens, 'hall', { ...dup });
drain();
check('重复推送不重复播（两屏已播数不增加该条）', screens.primary.rooms.hall.diffs.some((d) => d.kind === 'dup') && screens.backup.rooms.hall.diffs.some((d) => d.kind === 'dup'));

// 7) 制造漏播：备屏断网，厅内推 cap-3 v1，主屏播完；备屏重连前先做一次两屏对账
screenOffline(screens.backup, 'hall');
push('第三句', 1, { captionId: 'cap-3' });
drain();
check('主屏播了 cap-3 v1，备屏漏播', screens.primary.rooms.hall.cursors['cap-3'] === 1 && screens.backup.rooms.hall.cursors['cap-3'] === undefined);
// 备屏仍离线，手动对账以权威流补缺（演示“播完比对差异把漏播补上”）
const touched = reconcileBoth(screens, 'hall', feedByRoom.hall);
check('对账发现差异并给备屏补入 cap-3', touched === true && screens.backup.rooms.hall.pending.some((e) => e.captionId === 'cap-3'));
drain();
check('备屏补播 cap-3 v1', screens.backup.rooms.hall.cursors['cap-3'] === 1);

// 8) 译员改稿 cap-1 v4：主屏先收到并游标失效；备屏仍断网
publishRevision(screens, 'hall', 'cap-1', 4);
check('两屏 cap-1 游标失效标记', screens.primary.rooms.hall.cursorsValid['cap-1'] === false);
push('最终修订v4', 4);
drain();
check('主屏播到 cap-1 v4 且游标恢复有效', screens.primary.rooms.hall.cursors['cap-1'] === 4 && screens.primary.rooms.hall.cursorsValid['cap-1'] === true);
check('备屏断网没收到 v4，游标仍停在 v3（失效）', screens.backup.rooms.hall.cursors['cap-1'] === 3);

// 9) 备屏重连：按序号补齐 v4 并播完；之后两屏对账无差异
const filledV4 = screenReconnect(screens.backup, 'hall', feedByRoom.hall);
check('备屏重连只补 v4 一条', filledV4.length === 1 && filledV4[0].revision === 4);
drain();
check('备屏补播到 cap-1 v4，游标恢复有效', screens.backup.rooms.hall.cursors['cap-1'] === 4 && screens.backup.rooms.hall.cursorsValid['cap-1'] === true);
const touched2 = reconcileBoth(screens, 'hall', feedByRoom.hall);
check('全部一致后再次对账无改动', touched2 === false);

console.log(failures === 0 ? '\n全部端到端断言通过' : `\n${failures} 条失败`);
process.exit(failures === 0 ? 0 : 1);
