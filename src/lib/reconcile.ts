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

export type ScreenId = 'main' | 'backup';

export type Revision = {
  id: string;
  hallId: string;
  version: number;
  seq: number;
  text: string;
  at: string;
};

export type DiffKind =
  | 'stale' // 比本地已播小，作废
  | 'duplicate' // 同序号重复推送
  | 'version-reset' // 译员更新字幕版本，游标失效
  | 'missing' // 对账补播漏播
  | 'upgrade'; // 旧数据无游标，按最新版本起步

export type DiffRecord = {
  id: string;
  at: string;
  kind: DiffKind;
  screen: ScreenId;
  version: number;
  seq: number | null;
  message: string;
};

export type ScreenState = {
  id: ScreenId;
  hallId: string;
  version: number;
  /** 已播到的最高 seq；null 表示尚未开始跟播或版本已重置 */
  cursor: number | null;
  /** 是否已有跟播起点。false = 旧数据/无游标，首次收到修订时按最新版本起步 */
  started: boolean;
  paused: boolean;
  online: boolean;
  /** 是否正在补播（pending 里有可播项） */
  catchingUp: boolean;
  /** 待播队列，始终按 seq 升序 */
  pending: Revision[];
  /** 已播修订（当前版本内），按 seq 升序 */
  played: Revision[];
  current: Revision | null;
  diffs: DiffRecord[];
};

export type HallSource = {
  hallId: string;
  version: number;
  nextSeq: number;
  revisions: Revision[];
};

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function pushDiff(
  screen: ScreenState,
  kind: DiffKind,
  version: number,
  seq: number | null,
  message: string
): void {
  screen.diffs.unshift({ id: uid('diff'), at: nowIso(), kind, screen: screen.id, version, seq, message });
}

export function createScreen(id: ScreenId, hallId: string): ScreenState {
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
export function startFollowing(screen: ScreenState, hallId: string): void {
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
export function bootstrap(screen: ScreenState, source: HallSource): void {
  if (screen.started) return;
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
  pushDiff(
    screen,
    'upgrade',
    latest.version,
    latest.seq,
    `旧数据升级无游标，按已保存最新版本 v${latest.version} #${latest.seq} 起步`
  );
}

export function createHallSource(hallId: string): HallSource {
  return { hallId, version: 1, nextSeq: 1, revisions: [] };
}

/** 译员发布一条新修订（seq 递增）。 */
export function publishRevision(source: HallSource, text: string): Revision {
  const rev: Revision = {
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
export function bumpVersion(source: HallSource): void {
  source.version += 1;
  source.nextSeq = 1;
}

export function currentRevisions(source: HallSource): Revision[] {
  return source.revisions.filter((r) => r.version === source.version);
}

export type FeedResult = { accepted: boolean; reason?: string };

/**
 * 把一条修订喂给屏幕。处理顺序：
 * 1) 跨厅丢弃；2) 版本变化 → 已播游标失效、重新对账；
 * 3) seq ≤ 游标 → 作废；4) 同序号去重；5) 入队并按 seq 排序；
 * 6) 无游标（旧数据）→ 按最新版本起步；否则尝试播放。
 */
export function feedRevision(screen: ScreenState, rev: Revision): FeedResult {
  if (rev.hallId !== screen.hallId) {
    return { accepted: false, reason: 'wrong-hall' };
  }

  if (rev.version !== screen.version) {
    if (screen.started) {
      pushDiff(
        screen,
        'version-reset',
        screen.version,
        screen.cursor,
        `字幕版本 v${screen.version} → v${rev.version}，已播游标失效，重新对账`
      );
      screen.cursor = null;
      screen.played = [];
      screen.pending = [];
      screen.current = null;
      screen.version = rev.version;
    } else {
      screen.version = rev.version;
    }
  }

  // 同一条重复推送（id 相同）→ 去重；不同修订但序号已过期 → 作废
  if (screen.played.some((p) => p.id === rev.id) || screen.pending.some((p) => p.id === rev.id)) {
    pushDiff(screen, 'duplicate', screen.version, rev.seq, `修订 #${rev.seq} 已播过，同序号只播一次`);
    return { accepted: false, reason: 'duplicate' };
  }

  if (screen.cursor !== null && rev.seq <= screen.cursor) {
    pushDiff(
      screen,
      'stale',
      screen.version,
      rev.seq,
      `修订 #${rev.seq} 已播过（游标 #${screen.cursor}），作废并记入对账差异`
    );
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
    pushDiff(
      screen,
      'upgrade',
      screen.version,
      latest.seq,
      `旧数据升级无游标，按已保存最新版本 v${latest.version} #${latest.seq} 起步`
    );
    return { accepted: true, reason: 'upgrade' };
  }

  pump(screen);
  return { accepted: true };
}

/** 播放队首一条「序号恰好衔接游标」的修订；不跳号、不重播。 */
export function pumpOne(screen: ScreenState): boolean {
  if (screen.paused) return false;
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
  if (!screen.played.some((p) => p.seq === next.seq)) screen.played.push(next);
  screen.current = next;
  screen.played.sort((a, b) => a.seq - b.seq);
  screen.catchingUp = screen.pending.length > 0;
  return true;
}

/** 一次性把可衔接的待播修订播完。 */
export function pump(screen: ScreenState): void {
  while (pumpOne(screen)) {
    /* noop */
  }
}

/** 主持人暂停：只管本屏，待播队列原样保留。 */
export function pauseScreen(screen: ScreenState): void {
  screen.paused = true;
  screen.catchingUp = false;
}

/** 恢复：从暂停点（游标处）接着播。 */
export function resumeScreen(screen: ScreenState): void {
  screen.paused = false;
  pump(screen);
}

export function setOnline(screen: ScreenState, online: boolean): void {
  screen.online = online;
  if (online) pump(screen);
  else screen.catchingUp = false;
}

/** 断网恢复后补齐：把源里当前版本的修订按序喂给屏幕。 */
export function catchUp(screen: ScreenState, source: HallSource): void {
  if (!screen.online) return;
  if (!screen.started) {
    bootstrap(screen, source);
    return;
  }
  for (const rev of currentRevisions(source)) {
    feedRevision(screen, rev);
  }
}

export type ReconcileResult = {
  filled: number;
  gaps: Array<{ screen: ScreenId; seq: number }>;
};

/**
 * 两块屏跟同一厅，播完比对差异：
 * 找出一块播了、另一块没播的序号，把漏播的修订补喂给缺的那块。
 * 跨厅或版本不一致时不对账。
 */
export function reconcile(a: ScreenState, b: ScreenState): ReconcileResult {
  const gaps: Array<{ screen: ScreenId; seq: number }> = [];
  if (a.hallId !== b.hallId || a.version !== b.version) {
    return { filled: 0, gaps };
  }

  const aSeqs = new Set(a.played.map((p) => p.seq));
  const bSeqs = new Set(b.played.map((p) => p.seq));
  const all = new Set<number>([...aSeqs, ...bSeqs]);

  for (const seq of all) {
    if (aSeqs.has(seq) && !bSeqs.has(seq)) gaps.push({ screen: b.id, seq });
    if (bSeqs.has(seq) && !aSeqs.has(seq)) gaps.push({ screen: a.id, seq });
  }
  gaps.sort((x, y) => x.seq - y.seq);

  let filled = 0;
  for (const gap of gaps) {
    const target = gap.screen === a.id ? a : b;
    const source = gap.screen === a.id ? b : a;
    const rev = source.played.find((p) => p.seq === gap.seq);
    if (!rev) continue;
    if (target.cursor !== null && gap.seq <= target.cursor) {
      // 早于本屏起点（旧数据起步点），无法补播，仅记差异
      pushDiff(
        target,
        'missing',
        target.version,
        gap.seq,
        `对账发现 #${gap.seq} 漏播，但早于本屏起点（游标 #${target.cursor}），未补`
      );
      continue;
    }
    const result = feedRevision(target, rev);
    if (result.accepted && target.played.some((p) => p.seq === gap.seq)) {
      filled += 1;
      pushDiff(
        target,
        'missing',
        target.version,
        gap.seq,
        `对账补播：漏播的 #${gap.seq} 已补上`
      );
    }
  }
  return { filled, gaps };
}
