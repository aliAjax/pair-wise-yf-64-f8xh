import assert from 'node:assert';
import {
  createScreen,
  startFollowing,
  bootstrap,
  createHallSource,
  publishRevision,
  bumpVersion,
  feedRevision,
  pauseScreen,
  resumeScreen,
  setOnline,
  catchUp,
  reconcile,
  type ScreenState,
  type HallSource,
  type Revision
} from './reconcile';

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function seqs(s: ScreenState): number[] {
  return s.played.map((p) => p.seq);
}
function pendSeqs(s: ScreenState): number[] {
  return s.pending.map((p) => p.seq);
}
function kinds(s: ScreenState): string[] {
  return s.diffs.map((d) => d.kind);
}

function setup(): { src: HallSource; main: ScreenState; backup: ScreenState } {
  const src = createHallSource('hall-a');
  const main = createScreen('main', 'hall-a');
  const backup = createScreen('backup', 'hall-a');
  startFollowing(main, 'hall-a');
  startFollowing(backup, 'hall-a');
  return { src, main, backup };
}

function push(src: HallSource, text = '字幕'): Revision {
  return publishRevision(src, text);
}

console.log('跟播与补齐');
test('按序号跟播：1,2,3 依次播放，游标到 3', () => {
  const { src, main } = setup();
  feedRevision(main, push(src, '一'));
  feedRevision(main, push(src, '二'));
  feedRevision(main, push(src, '三'));
  assert.deepStrictEqual(seqs(main), [1, 2, 3]);
  assert.strictEqual(main.cursor, 3);
  assert.strictEqual(main.current?.text, '三');
});

test('断网恢复后补齐：离线期间攒下的修订按序号补齐', () => {
  const { src, main } = setup();
  feedRevision(main, push(src, '一'));
  setOnline(main, false);
  push(src, '二');
  push(src, '三');
  push(src, '四');
  setOnline(main, true);
  catchUp(main, src);
  assert.deepStrictEqual(seqs(main), [1, 2, 3, 4]);
  assert.strictEqual(main.cursor, 4);
});

test('补播没走完前新到的排在后面', () => {
  const { src, main } = setup();
  const r1 = push(src, '一');
  feedRevision(main, r1);
  pauseScreen(main);
  // 暂停期间攒下的修订喂进来，留在 pending
  feedRevision(main, push(src, '二'));
  feedRevision(main, push(src, '三'));
  feedRevision(main, push(src, '四'));
  assert.deepStrictEqual(pendSeqs(main), [2, 3, 4]);
  // 补播期间又到一条新的，应排在后面
  feedRevision(main, push(src, '五'));
  assert.deepStrictEqual(pendSeqs(main), [2, 3, 4, 5]);
  resumeScreen(main);
  assert.deepStrictEqual(seqs(main), [1, 2, 3, 4, 5]);
});

console.log('去重与作废');
test('同序号只播一次：同一条重复推送不重播', () => {
  const { src, main } = setup();
  const r1 = push(src, '一');
  feedRevision(main, r1);
  feedRevision(main, r1); // 同一条再推一遍
  assert.deepStrictEqual(seqs(main), [1]);
  assert.ok(kinds(main).includes('duplicate'));
});

test('比本地已播小的作废并记对账差异', () => {
  const { src, main } = setup();
  feedRevision(main, push(src, '一'));
  feedRevision(main, push(src, '二'));
  // 不同修订但序号已过期（seq 1）又推过来
  const stale: Revision = { ...push(src, '过期'), seq: 1 };
  feedRevision(main, stale);
  assert.deepStrictEqual(seqs(main), [1, 2]);
  assert.ok(kinds(main).includes('stale'));
});

test('序号断档不跳播：缺 2 时 3 先排队', () => {
  const { src, main } = setup();
  feedRevision(main, push(src, '一'));
  const r3: Revision = { ...push(src, '三'), seq: 3 };
  feedRevision(main, r3);
  assert.deepStrictEqual(seqs(main), [1]);
  assert.deepStrictEqual(pendSeqs(main), [3]);
  const r2: Revision = { ...push(src, '二'), seq: 2 };
  feedRevision(main, r2);
  assert.deepStrictEqual(seqs(main), [1, 2, 3]);
});

console.log('暂停');
test('暂停只管本屏：攒下的留在待播队列，恢复后从暂停点接着播', () => {
  const { src, main, backup } = setup();
  const r1 = push(src, '一');
  feedRevision(main, r1);
  feedRevision(backup, r1);
  pauseScreen(main);
  push(src, '二');
  push(src, '三');
  catchUp(main, src);
  // 主屏暂停：pending 攒着，已播不增加
  assert.deepStrictEqual(seqs(main), [1]);
  assert.deepStrictEqual(pendSeqs(main), [2, 3]);
  // 备屏不受影响
  catchUp(backup, src);
  assert.deepStrictEqual(seqs(backup), [1, 2, 3]);
  // 主屏恢复：从暂停点接着播
  resumeScreen(main);
  assert.deepStrictEqual(seqs(main), [1, 2, 3]);
  assert.strictEqual(main.cursor, 3);
});

console.log('版本更新');
test('译员更新字幕版本：已播游标失效并重新对账', () => {
  const { src, main } = setup();
  feedRevision(main, push(src, '旧版一'));
  feedRevision(main, push(src, '旧版二'));
  bumpVersion(src);
  assert.strictEqual(src.version, 2);
  feedRevision(main, publishRevision(src, '新版一'));
  assert.ok(kinds(main).includes('version-reset'));
  assert.strictEqual(main.version, 2);
  assert.deepStrictEqual(seqs(main), [1]); // 新版本从 seq 1 重新跟
  assert.strictEqual(main.cursor, 1);
});

console.log('旧数据升级');
test('旧数据无游标：按已保存最新版本起步，不回放历史', () => {
  const src = createHallSource('hall-a');
  push(src, '一');
  push(src, '二');
  push(src, '三');
  const main = createScreen('main', 'hall-a'); // started=false
  bootstrap(main, src);
  assert.deepStrictEqual(seqs(main), [3]);
  assert.strictEqual(main.cursor, 3);
  assert.ok(kinds(main).includes('upgrade'));
  // 之后新修订正常跟播
  feedRevision(main, push(src, '四'));
  assert.deepStrictEqual(seqs(main), [3, 4]);
});

console.log('对账补播');
test('两块屏跟同一厅：播完比对差异，把漏播的补上', () => {
  const { src, main, backup } = setup();
  feedRevision(main, push(src, '一'));
  feedRevision(main, push(src, '二'));
  feedRevision(main, push(src, '三'));
  // 备屏只播了 1，漏 2、3
  feedRevision(backup, src.revisions[0]);
  assert.deepStrictEqual(seqs(backup), [1]);
  const result = reconcile(main, backup);
  assert.deepStrictEqual(seqs(backup), [1, 2, 3]);
  assert.ok(result.filled >= 2);
  assert.ok(kinds(backup).includes('missing'));
});

test('对账：一块漏播最近两条，另一块补上', () => {
  const { src, main, backup } = setup();
  feedRevision(main, push(src, '一'));
  feedRevision(main, push(src, '二'));
  feedRevision(main, push(src, '三'));
  // 备屏只播了 1
  feedRevision(backup, src.revisions[0]);
  const result = reconcile(main, backup);
  assert.deepStrictEqual(seqs(backup), [1, 2, 3]);
  assert.ok(result.filled >= 2);
});

test('跨厅不对账', () => {
  const { src, main } = setup();
  feedRevision(main, push(src, '一'));
  const other = createScreen('backup', 'hall-b');
  startFollowing(other, 'hall-b');
  const r = publishRevision(createHallSource('hall-b'), '别的厅');
  feedRevision(other, r);
  const result = reconcile(main, other);
  assert.strictEqual(result.filled, 0);
});

console.log('网络恢复后各自跳到收到的那版 → 补齐');
test('断网恢复后不再各自跳版：备屏补齐到与主屏一致', () => {
  const { src, main, backup } = setup();
  const r1 = push(src, '一');
  feedRevision(main, r1);
  feedRevision(backup, r1);
  // 备屏断网
  setOnline(backup, false);
  push(src, '二');
  push(src, '三');
  // 主屏继续
  catchUp(main, src);
  assert.deepStrictEqual(seqs(main), [1, 2, 3]);
  // 备屏恢复：补齐，而不是跳到收到的那版
  setOnline(backup, true);
  catchUp(backup, src);
  assert.deepStrictEqual(seqs(backup), [1, 2, 3]);
  assert.deepStrictEqual(seqs(main), seqs(backup));
});

console.log(`\n${passed} 项测试通过`);
if (process.exitCode === 1) process.exit(1);
