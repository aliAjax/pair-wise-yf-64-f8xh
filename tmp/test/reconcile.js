"use strict";
// 会议大屏主备屏「修订序号跟播」引擎
// 纯逻辑、无框架依赖：可直接跑在普通对象上（测试），也可跑在 Qwik store 上（UI）。
//
// 核心约定：
// - 每条字幕修订带 (version, seq)：version 是字幕版本，seq 是该版本内单调递增的修订序号。
// - 屏幕用 cursor 记录「已播到的最高 seq」，只播 seq > cursor 的修订，且同序号只播一次。
// - 断网恢复后按 seq 补齐；比 cursor 小的作废并记对账差异；补播期间新到的排在后面。
// - 暂停只管本屏：攒下的留在 pending，恢复后从 cursor 接着播。
// - 两块屏跟同一厅，播完比对 played 集合，漏播的补上。
// - 译员更新字幕版本 → cursor 失效、重新对账；旧数据无 cursor → 按已保存最新版本起步。
Object.defineProperty(exports, "__esModule", { value: true });
exports.createScreen = createScreen;
exports.startFollowing = startFollowing;
exports.bootstrap = bootstrap;
exports.createHallSource = createHallSource;
exports.publishRevision = publishRevision;
exports.bumpVersion = bumpVersion;
exports.currentRevisions = currentRevisions;
exports.feedRevision = feedRevision;
exports.pumpOne = pumpOne;
exports.pump = pump;
exports.pauseScreen = pauseScreen;
exports.resumeScreen = resumeScreen;
exports.setOnline = setOnline;
exports.catchUp = catchUp;
exports.reconcile = reconcile;
let counter = 0;
function uid(prefix) {
    counter += 1;
    return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}
function nowIso() {
    return new Date().toISOString();
}
function pushDiff(screen, kind, version, seq, message) {
    screen.diffs.unshift({ id: uid('diff'), at: nowIso(), kind, screen: screen.id, version, seq, message });
}
function createScreen(id, hallId) {
    return {
        id,
        hallId,
        version: 1,
        cursor: null,
        started: false,
        paused: false,
        online: true,
        catchingUp: false,
        pending: [],
        played: [],
        current: null,
        diffs: []
    };
}
/** 从零开始跟某厅：清掉游标与历史，准备从 seq 1 按序播。 */
function startFollowing(screen, hallId) {
    screen.hallId = hallId;
    screen.version = 1;
    screen.cursor = null;
    screen.started = true;
    screen.paused = false;
    screen.catchingUp = false;
    screen.pending = [];
    screen.played = [];
    screen.current = null;
    screen.diffs = [];
}
/** 旧数据升级：没有游标，按已保存的最新版本起步，不回放历史。 */
function bootstrap(screen, source) {
    if (screen.started)
        return;
    const revs = currentRevisions(source);
    if (revs.length === 0) {
        screen.started = true;
        return;
    }
    const latest = revs[revs.length - 1];
    screen.version = latest.version;
    screen.cursor = latest.seq;
    screen.played = [latest];
    screen.current = latest;
    screen.started = true;
    pushDiff(screen, 'upgrade', latest.version, latest.seq, `旧数据升级无游标，按已保存最新版本 v${latest.version} #${latest.seq} 起步`);
}
function createHallSource(hallId) {
    return { hallId, version: 1, nextSeq: 1, revisions: [] };
}
/** 译员发布一条新修订（seq 递增）。 */
function publishRevision(source, text) {
    const rev = {
        id: uid('rev'),
        hallId: source.hallId,
        version: source.version,
        seq: source.nextSeq,
        text,
        at: nowIso()
    };
    source.nextSeq += 1;
    source.revisions.push(rev);
    return rev;
}
/** 译员更新字幕版本：版本号 +1，seq 归零重新计数。 */
function bumpVersion(source) {
    source.version += 1;
    source.nextSeq = 1;
}
function currentRevisions(source) {
    return source.revisions.filter((r) => r.version === source.version);
}
/**
 * 把一条修订喂给屏幕。处理顺序：
 * 1) 跨厅丢弃；2) 版本变化 → 已播游标失效、重新对账；
 * 3) seq ≤ 游标 → 作废；4) 同序号去重；5) 入队并按 seq 排序；
 * 6) 无游标（旧数据）→ 按最新版本起步；否则尝试播放。
 */
function feedRevision(screen, rev) {
    if (rev.hallId !== screen.hallId) {
        return { accepted: false, reason: 'wrong-hall' };
    }
    if (rev.version !== screen.version) {
        if (screen.started) {
            pushDiff(screen, 'version-reset', screen.version, screen.cursor, `字幕版本 v${screen.version} → v${rev.version}，已播游标失效，重新对账`);
            screen.cursor = null;
            screen.played = [];
            screen.pending = [];
            screen.current = null;
            screen.version = rev.version;
        }
        else {
            screen.version = rev.version;
        }
    }
    // 同一条重复推送（id 相同）→ 去重；不同修订但序号已过期 → 作废
    if (screen.played.some((p) => p.id === rev.id) || screen.pending.some((p) => p.id === rev.id)) {
        pushDiff(screen, 'duplicate', screen.version, rev.seq, `修订 #${rev.seq} 已播过，同序号只播一次`);
        return { accepted: false, reason: 'duplicate' };
    }
    if (screen.cursor !== null && rev.seq <= screen.cursor) {
        pushDiff(screen, 'stale', screen.version, rev.seq, `修订 #${rev.seq} 已播过（游标 #${screen.cursor}），作废并记入对账差异`);
        return { accepted: false, reason: 'stale' };
    }
    if (screen.played.some((p) => p.seq === rev.seq)) {
        pushDiff(screen, 'duplicate', screen.version, rev.seq, `修订 #${rev.seq} 已播过，同序号只播一次`);
        return { accepted: false, reason: 'duplicate' };
    }
    if (screen.pending.some((p) => p.seq === rev.seq)) {
        pushDiff(screen, 'duplicate', screen.version, rev.seq, `修订 #${rev.seq} 已在待播队列，同序号只播一次`);
        return { accepted: false, reason: 'duplicate' };
    }
    screen.pending.push(rev);
    screen.pending.sort((a, b) => a.seq - b.seq);
    if (!screen.started) {
        const latest = screen.pending[screen.pending.length - 1];
        screen.pending = [];
        screen.cursor = latest.seq;
        screen.played = [latest];
        screen.current = latest;
        screen.started = true;
        pushDiff(screen, 'upgrade', screen.version, latest.seq, `旧数据升级无游标，按已保存最新版本 v${latest.version} #${latest.seq} 起步`);
        return { accepted: true, reason: 'upgrade' };
    }
    pump(screen);
    return { accepted: true };
}
/** 播放队首一条「序号恰好衔接游标」的修订；不跳号、不重播。 */
function pumpOne(screen) {
    if (screen.paused)
        return false;
    if (screen.pending.length === 0) {
        screen.catchingUp = false;
        return false;
    }
    const next = screen.pending[0];
    const expected = screen.cursor === null ? 1 : screen.cursor + 1;
    if (next.seq !== expected) {
        // 序号断档：等缺的那条，不跳播
        screen.catchingUp = false;
        return false;
    }
    screen.pending.shift();
    screen.cursor = next.seq;
    if (!screen.played.some((p) => p.seq === next.seq))
        screen.played.push(next);
    screen.current = next;
    screen.played.sort((a, b) => a.seq - b.seq);
    screen.catchingUp = screen.pending.length > 0;
    return true;
}
/** 一次性把可衔接的待播修订播完。 */
function pump(screen) {
    while (pumpOne(screen)) {
        /* noop */
    }
}
/** 主持人暂停：只管本屏，待播队列原样保留。 */
function pauseScreen(screen) {
    screen.paused = true;
    screen.catchingUp = false;
}
/** 恢复：从暂停点（游标处）接着播。 */
function resumeScreen(screen) {
    screen.paused = false;
    pump(screen);
}
function setOnline(screen, online) {
    screen.online = online;
    if (online)
        pump(screen);
    else
        screen.catchingUp = false;
}
/** 断网恢复后补齐：把源里当前版本的修订按序喂给屏幕。 */
function catchUp(screen, source) {
    if (!screen.online)
        return;
    if (!screen.started) {
        bootstrap(screen, source);
        return;
    }
    for (const rev of currentRevisions(source)) {
        feedRevision(screen, rev);
    }
}
/**
 * 两块屏跟同一厅，播完比对差异：
 * 找出一块播了、另一块没播的序号，把漏播的修订补喂给缺的那块。
 * 跨厅或版本不一致时不对账。
 */
function reconcile(a, b) {
    const gaps = [];
    if (a.hallId !== b.hallId || a.version !== b.version) {
        return { filled: 0, gaps };
    }
    const aSeqs = new Set(a.played.map((p) => p.seq));
    const bSeqs = new Set(b.played.map((p) => p.seq));
    const all = new Set([...aSeqs, ...bSeqs]);
    for (const seq of all) {
        if (aSeqs.has(seq) && !bSeqs.has(seq))
            gaps.push({ screen: b.id, seq });
        if (bSeqs.has(seq) && !aSeqs.has(seq))
            gaps.push({ screen: a.id, seq });
    }
    gaps.sort((x, y) => x.seq - y.seq);
    let filled = 0;
    for (const gap of gaps) {
        const target = gap.screen === a.id ? a : b;
        const source = gap.screen === a.id ? b : a;
        const rev = source.played.find((p) => p.seq === gap.seq);
        if (!rev)
            continue;
        if (target.cursor !== null && gap.seq <= target.cursor) {
            // 早于本屏起点（旧数据起步点），无法补播，仅记差异
            pushDiff(target, 'missing', target.version, gap.seq, `对账发现 #${gap.seq} 漏播，但早于本屏起点（游标 #${target.cursor}），未补`);
            continue;
        }
        const result = feedRevision(target, rev);
        if (result.accepted && target.played.some((p) => p.seq === gap.seq)) {
            filled += 1;
            pushDiff(target, 'missing', target.version, gap.seq, `对账补播：漏播的 #${gap.seq} 已补上`);
        }
    }
    return { filled, gaps };
}
