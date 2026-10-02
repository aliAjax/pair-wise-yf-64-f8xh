import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  newScreen,
  ensureRoom,
  baselineScreen,
  enqueue,
  goOffline,
  reconnect,
  pump,
  setPaused,
  reconcileWithPeer,
  invalidateCursorAfterRevision,
  isCaughtUp,
  type FeedEvent
} from './engine';

let seqCounter = 0;
function makeEvent(partial: Partial<FeedEvent> & Pick<FeedEvent, 'captionId' | 'revision'>): FeedEvent {
  seqCounter++;
  return {
    seq: partial.seq ?? seqCounter,
    captionId: partial.captionId,
    speechId: 'speech-1',
    language: '中文',
    interpreter: '周雨',
    text: `字幕 ${partial.captionId} v${partial.revision}`,
    revision: partial.revision,
    at: new Date().toISOString()
  };
}

function pair() {
  seqCounter = 0;
  const primary = newScreen('primary', '主屏');
  const backup = newScreen('backup', '备屏');
  ensureRoom(primary, 'hall-a');
  ensureRoom(backup, 'hall-a');
  return { primary, backup };
}

describe('大屏按修订序号跟播', () => {
  it('同一条重复推送只播一次（dup 记对账差异）', () => {
    const { primary } = pair();
    const room = primary.rooms['hall-a'];
    const e1 = makeEvent({ captionId: 'c1', revision: 1 });
    assert.equal(enqueue(room, e1), 'queued');
    assert.equal(enqueue(room, { ...e1 }), 'dup');
    pump(room, 10);
    assert.equal(room.played.length, 1);
    assert.equal(room.cursors.c1, 1);
    // 已播后再来一份同序号同样作废
    assert.equal(enqueue(room, { ...e1 }), 'dup');
    assert.equal(room.diffs.filter((d) => d.kind === 'dup').length, 2);
    assert.equal(room.pending.length, 0);
  });

  it('比本地已播小的修订作废并记进对账差异', () => {
    const { primary } = pair();
    const room = primary.rooms['hall-a'];
    enqueue(room, makeEvent({ captionId: 'c1', revision: 1 }));
    pump(room, 10);
    enqueue(room, makeEvent({ captionId: 'c1', revision: 2 }));
    pump(room, 10);
    assert.equal(room.cursors.c1, 2);
    const old = makeEvent({ captionId: 'c1', revision: 1 });
    assert.equal(enqueue(room, old), 'stale');
    assert.equal(room.pending.length, 0);
    assert.ok(room.diffs.some((d) => d.kind === 'stale' && d.revision === 1));
  });

  it('重连后把攒下的修订按序号补齐，补播没走完前新到排在后面', () => {
    const { primary } = pair();
    const room = primary.rooms['hall-a'];
    enqueue(room, makeEvent({ captionId: 'c1', revision: 1 }));
    pump(room, 10);

    // 断网期间，厅内产生 c2 r1(seq2)、c1 r2(seq3)
    goOffline(room);
    const offlineEvents = [
      makeEvent({ captionId: 'c2', revision: 1 }),
      makeEvent({ captionId: 'c1', revision: 2 })
    ];
    assert.equal(room.online, false);

    const filled = reconnect(room, offlineEvents);
    assert.equal(filled.length, 2);
    assert.equal(room.catchingUp, true);
    assert.deepEqual(room.pending.map((e) => e.seq), [2, 3]);

    // 补播没走完前新到直播修订（seq4）排在补齐修订后面
    const live = makeEvent({ captionId: 'c3', revision: 1 });
    enqueue(room, live);
    assert.deepEqual(room.pending.map((e) => e.seq), [2, 3, 4]);

    pump(room, 1);
    assert.equal(room.played[0].seq, 2);
    pump(room, 10);
    assert.equal(room.catchingUp, false);
    // 补齐的 2、3 与直播的 4 按 seq 顺序播完（断网前已播的 seq1 仍在已播栈中）
    assert.deepEqual(room.played.map((e) => e.seq).slice(0, 3), [4, 3, 2]);
    assert.ok(room.diffs.some((d) => d.kind === 'gap-filled'));
  });

  it('补齐时遇到比已播小的修订照样作废，不入待播', () => {
    const { primary } = pair();
    const room = primary.rooms['hall-a'];
    enqueue(room, makeEvent({ captionId: 'c1', revision: 1 }));
    pump(room, 10);
    goOffline(room);
    // 厅里重发了一个旧版 r1（seq2）+ 新版 r2（seq3）
    const events = [
      makeEvent({ captionId: 'c1', revision: 1 }),
      makeEvent({ captionId: 'c1', revision: 2 })
    ];
    const filled = reconnect(room, events);
    assert.equal(filled.length, 1);
    assert.equal(filled[0].revision, 2);
    // 重发的 r1 与本屏游标同序号 → dup 作废；真正更小的 r0 → stale
    assert.ok(room.diffs.some((d) => d.kind === 'dup' && d.revision === 1));
    assert.equal(enqueue(room, makeEvent({ captionId: 'c1', revision: 0 })), 'stale');
    assert.ok(room.diffs.some((d) => d.kind === 'stale' && d.revision === 0));
  });

  it('主持人暂停只管本屏，攒下留队列，恢复从暂停点接着播', () => {
    const { primary, backup } = pair();
    const a = primary.rooms['hall-a'];
    const b = backup.rooms['hall-a'];
    const e1 = makeEvent({ captionId: 'c1', revision: 1 });
    enqueue(a, e1);
    enqueue(b, { ...e1 });
    setPaused(a, true);
    pump(a, 10);
    // 备屏不受影响
    pump(b, 10);
    assert.equal(a.played.length, 0);
    assert.equal(a.pending.length, 1);
    assert.equal(b.played.length, 1);

    // 暂停期间继续攒
    enqueue(a, makeEvent({ captionId: 'c2', revision: 1 }));
    assert.equal(a.pending.length, 2);
    pump(a, 10);
    assert.equal(a.played.length, 0);

    // 恢复后从暂停点（seq1）接着播
    setPaused(a, false);
    pump(a, 1);
    assert.equal(a.played[0].seq, 1);
    pump(a, 10);
    assert.deepEqual(a.played.map((e) => e.seq), [2, 1]);
  });

  it('两块屏播完后比对差异，把漏播的补上', () => {
    const { primary, backup } = pair();
    const a = primary.rooms['hall-a'];
    const b = backup.rooms['hall-a'];

    const events = [
      makeEvent({ captionId: 'c1', revision: 1 }),
      makeEvent({ captionId: 'c2', revision: 1 }),
      makeEvent({ captionId: 'c1', revision: 2 })
    ];

    // 主屏全部收到播完；备屏漏了 seq2（c2 r1）
    for (const e of events) enqueue(a, e);
    enqueue(b, events[0]);
    enqueue(b, events[2]);
    pump(a, 10);
    pump(b, 10);
    assert.equal(a.cursors.c2, 1);
    assert.equal(b.cursors.c2, undefined);

    // 模拟“播完”：两块屏待播空，做相互对账
    const report = reconcileWithPeer(backup, events, primary, 'hall-a');
    reconcileWithPeer(primary, events, backup, 'hall-a');
    assert.equal(report.enqueued, 1);
    assert.ok(b.pending.some((e) => e.captionId === 'c2'));
    assert.ok(b.diffs.some((d) => d.kind === 'peer-filled'));
    pump(b, 10);
    assert.equal(b.cursors.c2, 1);
    // 补播后两屏游标一致
    assert.deepEqual(b.cursors, a.cursors);
  });

  it('译员更新已播字幕版本：游标失效并重新对账，新版补播', () => {
    const { primary, backup } = pair();
    const a = primary.rooms['hall-a'];
    const b = backup.rooms['hall-a'];
    const e1 = makeEvent({ captionId: 'c1', revision: 1 });
    enqueue(a, e1);
    enqueue(b, { ...e1 });
    pump(a, 10);
    pump(b, 10);

    // 译员改稿：主屏收到新版，备屏断网没收到
    goOffline(b);
    const e2 = makeEvent({ captionId: 'c1', revision: 2 });
    invalidateCursorAfterRevision(a, 'c1', 2);
    invalidateCursorAfterRevision(b, 'c1', 2);
    enqueue(a, e2);
    assert.equal(a.cursorsValid.c1, false);
    pump(a, 10);
    assert.equal(a.cursors.c1, 2);
    assert.equal(a.cursorsValid.c1, true);

    // 备屏重连：权威流里补齐新版；旧版 r1 被作废记录但新版 r2 正常补播
    const filled = reconnect(b, [e1, e2]);
    assert.equal(filled.length, 1);
    assert.equal(filled[0].revision, 2);
    pump(b, 10);
    assert.equal(b.cursors.c1, 2);
    assert.equal(b.cursorsValid.c1, true);
    assert.ok(b.diffs.some((d) => d.kind === 'cursor-reset'));
  });

  it('旧数据升级后没有游标：按已保存的最新版本起步，不重播历史', () => {
    const primary = newScreen('primary', '主屏');
    const latest = {
      c1: { revision: 3, seq: 10 },
      c2: { revision: 1, seq: 11 }
    };
    const room = baselineScreen(primary, 'hall-a', latest);
    assert.equal(room.cursors.c1, 3);
    assert.equal(room.cursors.c2, 1);
    assert.equal(room.played.length, 0);
    assert.equal(room.reconciledThrough, 11);

    // 历史修订再来不重播
    const oldEvent = makeEvent({ captionId: 'c1', revision: 2, seq: 12 });
    assert.equal(enqueue(room, oldEvent), 'stale');
    // 同序号也不重播
    const same = makeEvent({ captionId: 'c1', revision: 3, seq: 13 });
    assert.equal(enqueue(room, same), 'dup');
    // 新修订正常播
    const next = makeEvent({ captionId: 'c1', revision: 4, seq: 14 });
    assert.equal(enqueue(room, next), 'queued');
    pump(room, 10);
    assert.equal(room.cursors.c1, 4);
  });

  it('待播始终按 seq 升序：小序号补齐修订先于大序号直播修订', () => {
    const { primary } = pair();
    const room = primary.rooms['hall-a'];
    const later = makeEvent({ captionId: 'c3', revision: 1, seq: 50 });
    const earlier = makeEvent({ captionId: 'c2', revision: 1, seq: 20 });
    enqueue(room, later);
    enqueue(room, earlier);
    pump(room, 1);
    assert.equal(room.played[0].seq, 20);
  });

  it('播完判定：暂停/补播中/有待播都不算播完', () => {
    const { primary } = pair();
    const room = primary.rooms['hall-a'];
    room.reconciledThrough = 3;
    assert.equal(isCaughtUp(room, 3), true);
    setPaused(room, true);
    assert.equal(isCaughtUp(room, 3), false);
    setPaused(room, false);
    room.catchingUp = true;
    assert.equal(isCaughtUp(room, 3), false);
    room.catchingUp = false;
    assert.equal(isCaughtUp(room, 4), false);
  });
});
