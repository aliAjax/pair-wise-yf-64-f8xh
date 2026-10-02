"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_assert_1 = __importDefault(require("node:assert"));
const reconcile_1 = require("./reconcile");
let passed = 0;
function test(name, fn) {
    try {
        fn();
        passed += 1;
        console.log(`  ✓ ${name}`);
    }
    catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(err);
        process.exitCode = 1;
    }
}
function seqs(s) {
    return s.played.map((p) => p.seq);
}
function pendSeqs(s) {
    return s.pending.map((p) => p.seq);
}
function kinds(s) {
    return s.diffs.map((d) => d.kind);
}
function setup() {
    const src = (0, reconcile_1.createHallSource)('hall-a');
    const main = (0, reconcile_1.createScreen)('main', 'hall-a');
    const backup = (0, reconcile_1.createScreen)('backup', 'hall-a');
    (0, reconcile_1.startFollowing)(main, 'hall-a');
    (0, reconcile_1.startFollowing)(backup, 'hall-a');
    return { src, main, backup };
}
function push(src, text = '字幕') {
    return (0, reconcile_1.publishRevision)(src, text);
}
console.log('跟播与补齐');
test('按序号跟播：1,2,3 依次播放，游标到 3', () => {
    const { src, main } = setup();
    (0, reconcile_1.feedRevision)(main, push(src, '一'));
    (0, reconcile_1.feedRevision)(main, push(src, '二'));
    (0, reconcile_1.feedRevision)(main, push(src, '三'));
    node_assert_1.default.deepStrictEqual(seqs(main), [1, 2, 3]);
    node_assert_1.default.strictEqual(main.cursor, 3);
    node_assert_1.default.strictEqual(main.current?.text, '三');
});
test('断网恢复后补齐：离线期间攒下的修订按序号补齐', () => {
    const { src, main } = setup();
    (0, reconcile_1.feedRevision)(main, push(src, '一'));
    (0, reconcile_1.setOnline)(main, false);
    push(src, '二');
    push(src, '三');
    push(src, '四');
    (0, reconcile_1.setOnline)(main, true);
    (0, reconcile_1.catchUp)(main, src);
    node_assert_1.default.deepStrictEqual(seqs(main), [1, 2, 3, 4]);
    node_assert_1.default.strictEqual(main.cursor, 4);
});
test('补播没走完前新到的排在后面', () => {
    const { src, main } = setup();
    const r1 = push(src, '一');
    (0, reconcile_1.feedRevision)(main, r1);
    (0, reconcile_1.pauseScreen)(main);
    // 暂停期间攒下的修订喂进来，留在 pending
    (0, reconcile_1.feedRevision)(main, push(src, '二'));
    (0, reconcile_1.feedRevision)(main, push(src, '三'));
    (0, reconcile_1.feedRevision)(main, push(src, '四'));
    node_assert_1.default.deepStrictEqual(pendSeqs(main), [2, 3, 4]);
    // 补播期间又到一条新的，应排在后面
    (0, reconcile_1.feedRevision)(main, push(src, '五'));
    node_assert_1.default.deepStrictEqual(pendSeqs(main), [2, 3, 4, 5]);
    (0, reconcile_1.resumeScreen)(main);
    node_assert_1.default.deepStrictEqual(seqs(main), [1, 2, 3, 4, 5]);
});
console.log('去重与作废');
test('同序号只播一次：同一条重复推送不重播', () => {
    const { src, main } = setup();
    const r1 = push(src, '一');
    (0, reconcile_1.feedRevision)(main, r1);
    (0, reconcile_1.feedRevision)(main, r1); // 同一条再推一遍
    node_assert_1.default.deepStrictEqual(seqs(main), [1]);
    node_assert_1.default.ok(kinds(main).includes('duplicate'));
});
test('比本地已播小的作废并记对账差异', () => {
    const { src, main } = setup();
    (0, reconcile_1.feedRevision)(main, push(src, '一'));
    (0, reconcile_1.feedRevision)(main, push(src, '二'));
    // 不同修订但序号已过期（seq 1）又推过来
    const stale = { ...push(src, '过期'), seq: 1 };
    (0, reconcile_1.feedRevision)(main, stale);
    node_assert_1.default.deepStrictEqual(seqs(main), [1, 2]);
    node_assert_1.default.ok(kinds(main).includes('stale'));
});
test('序号断档不跳播：缺 2 时 3 先排队', () => {
    const { src, main } = setup();
    (0, reconcile_1.feedRevision)(main, push(src, '一'));
    const r3 = { ...push(src, '三'), seq: 3 };
    (0, reconcile_1.feedRevision)(main, r3);
    node_assert_1.default.deepStrictEqual(seqs(main), [1]);
    node_assert_1.default.deepStrictEqual(pendSeqs(main), [3]);
    const r2 = { ...push(src, '二'), seq: 2 };
    (0, reconcile_1.feedRevision)(main, r2);
    node_assert_1.default.deepStrictEqual(seqs(main), [1, 2, 3]);
});
console.log('暂停');
test('暂停只管本屏：攒下的留在待播队列，恢复后从暂停点接着播', () => {
    const { src, main, backup } = setup();
    const r1 = push(src, '一');
    (0, reconcile_1.feedRevision)(main, r1);
    (0, reconcile_1.feedRevision)(backup, r1);
    (0, reconcile_1.pauseScreen)(main);
    push(src, '二');
    push(src, '三');
    (0, reconcile_1.catchUp)(main, src);
    // 主屏暂停：pending 攒着，已播不增加
    node_assert_1.default.deepStrictEqual(seqs(main), [1]);
    node_assert_1.default.deepStrictEqual(pendSeqs(main), [2, 3]);
    // 备屏不受影响
    (0, reconcile_1.catchUp)(backup, src);
    node_assert_1.default.deepStrictEqual(seqs(backup), [1, 2, 3]);
    // 主屏恢复：从暂停点接着播
    (0, reconcile_1.resumeScreen)(main);
    node_assert_1.default.deepStrictEqual(seqs(main), [1, 2, 3]);
    node_assert_1.default.strictEqual(main.cursor, 3);
});
console.log('版本更新');
test('译员更新字幕版本：已播游标失效并重新对账', () => {
    const { src, main } = setup();
    (0, reconcile_1.feedRevision)(main, push(src, '旧版一'));
    (0, reconcile_1.feedRevision)(main, push(src, '旧版二'));
    (0, reconcile_1.bumpVersion)(src);
    node_assert_1.default.strictEqual(src.version, 2);
    (0, reconcile_1.feedRevision)(main, (0, reconcile_1.publishRevision)(src, '新版一'));
    node_assert_1.default.ok(kinds(main).includes('version-reset'));
    node_assert_1.default.strictEqual(main.version, 2);
    node_assert_1.default.deepStrictEqual(seqs(main), [1]); // 新版本从 seq 1 重新跟
    node_assert_1.default.strictEqual(main.cursor, 1);
});
console.log('旧数据升级');
test('旧数据无游标：按已保存最新版本起步，不回放历史', () => {
    const src = (0, reconcile_1.createHallSource)('hall-a');
    push(src, '一');
    push(src, '二');
    push(src, '三');
    const main = (0, reconcile_1.createScreen)('main', 'hall-a'); // started=false
    (0, reconcile_1.bootstrap)(main, src);
    node_assert_1.default.deepStrictEqual(seqs(main), [3]);
    node_assert_1.default.strictEqual(main.cursor, 3);
    node_assert_1.default.ok(kinds(main).includes('upgrade'));
    // 之后新修订正常跟播
    (0, reconcile_1.feedRevision)(main, push(src, '四'));
    node_assert_1.default.deepStrictEqual(seqs(main), [3, 4]);
});
console.log('对账补播');
test('两块屏跟同一厅：播完比对差异，把漏播的补上', () => {
    const { src, main, backup } = setup();
    (0, reconcile_1.feedRevision)(main, push(src, '一'));
    (0, reconcile_1.feedRevision)(main, push(src, '二'));
    (0, reconcile_1.feedRevision)(main, push(src, '三'));
    // 备屏只播了 1，漏 2、3
    (0, reconcile_1.feedRevision)(backup, src.revisions[0]);
    node_assert_1.default.deepStrictEqual(seqs(backup), [1]);
    const result = (0, reconcile_1.reconcile)(main, backup);
    node_assert_1.default.deepStrictEqual(seqs(backup), [1, 2, 3]);
    node_assert_1.default.ok(result.filled >= 2);
    node_assert_1.default.ok(kinds(backup).includes('missing'));
});
test('对账：一块漏播最近两条，另一块补上', () => {
    const { src, main, backup } = setup();
    (0, reconcile_1.feedRevision)(main, push(src, '一'));
    (0, reconcile_1.feedRevision)(main, push(src, '二'));
    (0, reconcile_1.feedRevision)(main, push(src, '三'));
    // 备屏只播了 1
    (0, reconcile_1.feedRevision)(backup, src.revisions[0]);
    const result = (0, reconcile_1.reconcile)(main, backup);
    node_assert_1.default.deepStrictEqual(seqs(backup), [1, 2, 3]);
    node_assert_1.default.ok(result.filled >= 2);
});
test('跨厅不对账', () => {
    const { src, main } = setup();
    (0, reconcile_1.feedRevision)(main, push(src, '一'));
    const other = (0, reconcile_1.createScreen)('backup', 'hall-b');
    (0, reconcile_1.startFollowing)(other, 'hall-b');
    const r = (0, reconcile_1.publishRevision)((0, reconcile_1.createHallSource)('hall-b'), '别的厅');
    (0, reconcile_1.feedRevision)(other, r);
    const result = (0, reconcile_1.reconcile)(main, other);
    node_assert_1.default.strictEqual(result.filled, 0);
});
console.log('网络恢复后各自跳到收到的那版 → 补齐');
test('断网恢复后不再各自跳版：备屏补齐到与主屏一致', () => {
    const { src, main, backup } = setup();
    const r1 = push(src, '一');
    (0, reconcile_1.feedRevision)(main, r1);
    (0, reconcile_1.feedRevision)(backup, r1);
    // 备屏断网
    (0, reconcile_1.setOnline)(backup, false);
    push(src, '二');
    push(src, '三');
    // 主屏继续
    (0, reconcile_1.catchUp)(main, src);
    node_assert_1.default.deepStrictEqual(seqs(main), [1, 2, 3]);
    // 备屏恢复：补齐，而不是跳到收到的那版
    (0, reconcile_1.setOnline)(backup, true);
    (0, reconcile_1.catchUp)(backup, src);
    node_assert_1.default.deepStrictEqual(seqs(backup), [1, 2, 3]);
    node_assert_1.default.deepStrictEqual(seqs(main), seqs(backup));
});
console.log(`\n${passed} 项测试通过`);
if (process.exitCode === 1)
    process.exit(1);
