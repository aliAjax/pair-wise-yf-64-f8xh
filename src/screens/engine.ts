/**
 * 主备大屏按修订序号跟播 / 对账引擎（纯逻辑，框架无关）。
 *
 * 约定：
 * - 每个厅一条 append-only 修订流 FeedEvent，seq 为厅内单调递增的投递序号（用于排序与补齐），
 *   revision 为同一条字幕（captionId）的修订序号（用于游标、去重、作废判定）。
 * - 每块屏按“厅 + 屏”维护独立状态：游标（每条字幕已播到的 revision）、待播队列、
 *   已播记录、对账差异，以及只作用于本屏的暂停标志。
 */

export interface FeedEvent {
  seq: number;
  captionId: string;
  speechId: string;
  language: string;
  interpreter: string;
  text: string;
  revision: number;
  at: string;
}

export type DiffKind = 'stale' | 'dup' | 'gap-filled' | 'peer-filled' | 'cursor-reset';

export interface DiffEntry {
  id: string;
  at: string;
  kind: DiffKind;
  seq: number;
  captionId: string;
  revision: number;
  detail: string;
}

export interface PlayedRecord {
  captionId: string;
  revision: number;
  seq: number;
  at: string;
}

export interface ScreenRoomState {
  /** 已播游标：captionId -> 已播 revision；旧数据迁移时按保存的最新 revision 起步 */
  cursors: Record<string, number>;
  /** 游标是否有效；译员更新已播字幕后失效，重新对账/补播新版后恢复 */
  cursorsValid: Record<string, boolean>;
  /** 已收或已补齐、等待按序播出的修订，按 seq 升序 */
  pending: FeedEvent[];
  /** 播过的 (captionId, revision)，同序号只播一次 */
  played: PlayedRecord[];
  /** 对账差异：作废、重复、补齐等 */
  diffs: DiffEntry[];
  /** 补齐模式：重连补播未走完前，新到的直播修订排在后面 */
  catchingUp: boolean;
  /** 主持人暂停，只管本屏；期间攒下的留在待播队列 */
  paused: boolean;
  online: boolean;
  /** 已对账到的厅内 seq，避免两块屏播完后反复全量比对 */
  reconciledThrough: number;
  /** 本屏确实收到过（入过队/播过/判定过）的投递 seq，重连时不重复拉取 */
  seenSeqs: number[];
}

export type ScreenId = 'primary' | 'backup';

export interface ScreenState {
  id: ScreenId;
  name: string;
  rooms: Record<string, ScreenRoomState>;
}

export type EnqueueResult = 'queued' | 'dup' | 'stale';

const MAX_PLAYED = 200;
const MAX_DIFFS = 100;

export function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function newScreenRoom(online = true): ScreenRoomState {
  return {
    cursors: {},
    cursorsValid: {},
    pending: [],
    played: [],
    diffs: [],
    catchingUp: false,
    paused: false,
    online,
    reconciledThrough: 0,
    seenSeqs: []
  };
}

export function ensureRoom(screen: ScreenState, roomId: string): ScreenRoomState {
  let room = screen.rooms[roomId];
  if (!room) {
    room = newScreenRoom(true);
    screen.rooms[roomId] = room;
  }
  return room;
}

export function newScreen(id: ScreenId, name: string): ScreenState {
  return { id, name, rooms: {} };
}

/**
 * 旧数据升级：本地没有任何屏上状态时，按“已保存的最新版本”起步。
 * latestByCaption 为 captionId -> 最新 revision（以及对应的最新 seq，用于对账水位），
 * 这些历史修订不再补播，游标直接指向最新版。
 */
export function baselineScreen(
  screen: ScreenState,
  roomId: string,
  latestByCaption: Record<string, { revision: number; seq: number }>
): ScreenRoomState {
  const room = ensureRoom(screen, roomId);
  for (const [captionId, info] of Object.entries(latestByCaption)) {
    if (room.cursors[captionId] === undefined) {
      room.cursors[captionId] = info.revision;
      room.cursorsValid[captionId] = true;
      room.reconciledThrough = Math.max(room.reconciledThrough, info.seq);
      if (!room.seenSeqs.includes(info.seq)) room.seenSeqs.push(info.seq);
    }
  }
  return room;
}

export function pushDiff(room: ScreenRoomState, entry: Omit<DiffEntry, 'id' | 'at'>): DiffEntry {
  const diff: DiffEntry = { ...entry, id: uid(), at: new Date().toISOString() };
  room.diffs.unshift(diff);
  if (room.diffs.length > MAX_DIFFS) room.diffs.length = MAX_DIFFS;
  return diff;
}

/**
 * 收到一条修订（直播推送 / 重连补齐 / 对端补缺都走这里）：
 * - 比本地已播小（或等于游标）的旧序号：作废（dup 表示同序号重复，stale 表示更小修订），记对账差异；
 * - 同 (captionId, revision) 只进队一次；
 * - 其余按 seq 插入待播队列（seq 较小的补齐修订自然排在直播修订前面）。
 */
export function enqueue(
  room: ScreenRoomState,
  event: FeedEvent,
  source: 'live' | 'backfill' | 'reconcile' = 'live'
): EnqueueResult {
  if (!room.seenSeqs.includes(event.seq)) room.seenSeqs.push(event.seq);
  const playedRevision = room.cursors[event.captionId] ?? 0;
  if (event.revision < playedRevision) {
    pushDiff(room, {
      kind: 'stale',
      seq: event.seq,
      captionId: event.captionId,
      revision: event.revision,
      detail: `#${event.seq} v${event.revision} 小于本屏已播 v${playedRevision}，作废不播`
    });
    return 'stale';
  }
  // 游标已指向该 revision（已播，或旧数据按最新版本起步）：同序号不重复播
  if (event.revision === playedRevision && playedRevision > 0) {
    pushDiff(room, {
      kind: 'dup',
      seq: event.seq,
      captionId: event.captionId,
      revision: event.revision,
      detail: `#${event.seq} v${event.revision} 本屏已播（同序号），只播一次`
    });
    return 'dup';
  }
  if (room.pending.some((item) => item.captionId === event.captionId && item.revision === event.revision)) {
    pushDiff(room, {
      kind: 'dup',
      seq: event.seq,
      captionId: event.captionId,
      revision: event.revision,
      detail: `#${event.seq} v${event.revision} 已在待播队列，重复推送不重复播`
    });
    return 'dup';
  }
  room.pending.push(event);
  room.pending.sort((a, b) => a.seq - b.seq || a.revision - b.revision);
  if (source === 'backfill') {
    pushDiff(room, {
      kind: 'gap-filled',
      seq: event.seq,
      captionId: event.captionId,
      revision: event.revision,
      detail: `#${event.seq} v${event.revision} 重连后按序号补齐，等待按序补播`
    });
  }
  return 'queued';
}

/** 断网：仅切换连接状态，队列与游标原样保留（攒下的修订留在待播队列）。 */
export function goOffline(room: ScreenRoomState): void {
  room.online = false;
}

/**
 * 网络恢复：把断网期间厅内攒下（本屏从未收到）的修订按 seq 一次性补齐。
 * 补齐期间置 catchingUp，补播没走完前新到直播修订都排在补齐修订后面。
 */
export function reconnect(
  room: ScreenRoomState,
  feed: FeedEvent[]
): FeedEvent[] {
  room.online = true;
  const seen = new Set<number>(room.seenSeqs);

  const missing = feed
    .filter((event) => !seen.has(event.seq))
    .sort((a, b) => a.seq - b.seq);

  const enqueued: FeedEvent[] = [];
  for (const event of missing) {
    if (enqueue(room, event, 'backfill') === 'queued') enqueued.push(event);
  }
  if (enqueued.length > 0) room.catchingUp = true;
  return enqueued;
}

/** 播出一条：推进游标、记已播；同序号（含待播队列里的重复条目）只播一次。 */
function playOne(room: ScreenRoomState, event: FeedEvent): void {
  room.played.unshift({ captionId: event.captionId, revision: event.revision, seq: event.seq, at: new Date().toISOString() });
  if (room.played.length > MAX_PLAYED) room.played.length = MAX_PLAYED;
  room.cursors[event.captionId] = event.revision;
  room.cursorsValid[event.captionId] = true;
  // 清掉待播里同一条字幕的更旧修订（它们已作废）以及任何同序号重复
  room.pending = room.pending.filter(
    (item) =>
      item.seq !== event.seq &&
      !(item.captionId === event.captionId && item.revision <= event.revision)
  );
}

/**
 * 走一帧播出。暂停只管本屏：暂停期间不播，攒下的留在待播队列，恢复后从暂停点接着播。
 * limit 控制一次最多走几条（演示逐秒用 1）。
 */
export function pump(room: ScreenRoomState, limit = 1): FeedEvent[] {
  if (room.paused) return [];
  const playedNow: FeedEvent[] = [];
  let guard = 0;
  while (playedNow.length < limit && room.pending.length > 0 && guard < limit + 50) {
    guard++;
    // 永远先播 seq 最小的；补齐修订 seq 更小，直播新修订排在其后
    const next = room.pending.reduce((min, item) => (item.seq < min.seq ? item : min), room.pending[0]);
    room.pending = room.pending.filter((item) => item !== next);
    const playedRevision = room.cursors[next.captionId] ?? 0;
    if (next.revision < playedRevision) {
      pushDiff(room, {
        kind: 'stale',
        seq: next.seq,
        captionId: next.captionId,
        revision: next.revision,
        detail: `#${next.seq} v${next.revision} 播出前发现已播到 v${playedRevision}，作废`
      });
      continue;
    }
    if (next.revision === playedRevision && room.played.some((item) => item.captionId === next.captionId && item.revision === next.revision)) {
      pushDiff(room, {
        kind: 'dup',
        seq: next.seq,
        captionId: next.captionId,
        revision: next.revision,
        detail: `#${next.seq} v${next.revision} 已播过，跳过重复`
      });
      continue;
    }
    playOne(room, next);
    playedNow.push(next);
  }
  if (room.pending.length === 0) room.catchingUp = false;
  return playedNow;
}

/** 主持人暂停/恢复，只作用于本屏本厅。 */
export function setPaused(room: ScreenRoomState, paused: boolean): void {
  room.paused = paused;
}

/**
 * 译员更新字幕版本：对“已经播过该条旧版”的屏，已播游标失效。
 * 重新对账前游标不可信；若新版没收到（断网漏推），对账时会把新版补进待播。
 */
export function invalidateCursorAfterRevision(
  room: ScreenRoomState,
  captionId: string,
  newRevision: number
): boolean {
  const playedTo = room.cursors[captionId];
  if (playedTo === undefined || playedTo >= newRevision) return false;
  room.cursorsValid[captionId] = false;
  pushDiff(room, {
    kind: 'cursor-reset',
    seq: 0,
    captionId,
    revision: newRevision,
    detail: `译员发布 v${newRevision}，本屏已播游标 v${playedTo} 失效，需重新对账`
  });
  return true;
}

export interface ReconcileReport {
  enqueued: number;
  stale: number;
  behindCursors: string[];
  touched: boolean;
}

/**
 * 两块屏跟同一厅播完后比对差异：以厅内权威修订流为准，并互相核对游标。
 * - 本屏漏掉（游标未到、也不在待播）的修订补进待播队列；
 * - 比本屏已播小的修订依旧作废并记差异；
 * - 推进对账水位，避免重复全量比对。
 */
export function reconcileWithPeer(
  screen: ScreenState,
  feed: FeedEvent[],
  peer: ScreenState,
  roomId: string
): ReconcileReport {
  const room = ensureRoom(screen, roomId);
  const report: ReconcileReport = { enqueued: 0, stale: 0, behindCursors: [], touched: false };
  const peerRoom = peer.rooms[roomId];
  const through = feed.reduce((max, event) => Math.max(max, event.seq), 0);

  for (const event of [...feed].sort((a, b) => a.seq - b.seq)) {
    // 已对账水位之前的历史修订不再重复判定（基线起步的旧版也不重报作废）
    if (event.seq <= room.reconciledThrough) continue;
    const localRev = room.cursors[event.captionId] ?? 0;
    const inPending = room.pending.some((item) => item.captionId === event.captionId && item.revision === event.revision);
    const inPlayed = room.played.some((item) => item.captionId === event.captionId && item.revision === event.revision);
    if (inPlayed || inPending) continue;
    if (event.revision < localRev) {
      pushDiff(room, {
        kind: 'stale',
        seq: event.seq,
        captionId: event.captionId,
        revision: event.revision,
        detail: `对账：#${event.seq} v${event.revision} 小于本屏已播 v${localRev}，作废`
      });
      report.stale++;
      report.touched = true;
      continue;
    }
    if (event.revision > localRev) {
      if (enqueue(room, event, 'reconcile') === 'queued') {
        pushDiff(room, {
          kind: 'peer-filled',
          seq: event.seq,
          captionId: event.captionId,
          revision: event.revision,
          detail: peerRoom && (peerRoom.cursors[event.captionId] ?? 0) >= event.revision
            ? `两块屏播完比对：${peer.name} 已到 v${event.revision}，本屏漏播，补入待播`
            : `两块屏播完比对：权威流有 #${event.seq} v${event.revision}，本屏漏播，补入待播`
        });
        report.enqueued++;
        report.touched = true;
        if (!report.behindCursors.includes(event.captionId)) report.behindCursors.push(event.captionId);
      }
    }
  }

  // 互相核对游标：对端已播到更新版本而本屏落后时记录（新版已在上面入队补齐）
  if (peerRoom) {
    for (const [captionId, peerRev] of Object.entries(peerRoom.cursors)) {
      const localRev = room.cursors[captionId] ?? 0;
      if (peerRev > localRev && !room.pending.some((item) => item.captionId === captionId)) {
        report.behindCursors.push(captionId);
      }
    }
  }

  room.reconciledThrough = Math.max(room.reconciledThrough, through);
  if (room.pending.length > 0) room.catchingUp = true;
  return report;
}

/** 两块屏是否都播完（厅内权威流末尾），可以做一次对账。 */
export function isCaughtUp(room: ScreenRoomState, feedMaxSeq: number): boolean {
  return room.online && !room.paused && !room.catchingUp && room.pending.length === 0 && room.reconciledThrough >= feedMaxSeq;
}
