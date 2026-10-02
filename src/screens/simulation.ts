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
  uid,
  type ScreenState,
  type FeedEvent
} from './engine';

/**
 * 浏览器内模拟：
 * - captionFeed 是“厅内权威修订流”（每个厅一条 append-only seq）。
 * - 两块屏各自维护独立的连接状态、待播队列、已播游标与对账差异。
 * - 直播推送只投递给在线的屏；断网期间修订在厅内攒着，重连一次性按 seq 补齐。
 */

export interface ScreenWorld {
  /** 每个厅是否模拟重复推送（同一条修订连推两份） */
  dupPush: Record<string, boolean>;
}

export function createScreens(): { primary: ScreenState; backup: ScreenState } {
  const primary = newScreen('primary', '主屏');
  const backup = newScreen('backup', '备屏');
  return { primary, backup };
}

type ScreenInput = { primary: ScreenState; backup: ScreenState };

export function ensureScreenRooms(screens: ScreenInput, roomIds: string[]): void {
  for (const roomId of roomIds) {
    ensureRoom(screens.primary, roomId);
    ensureRoom(screens.backup, roomId);
  }
}

/** 旧数据升级：没有屏状态时，按各厅已保存字幕的最新版本起步，不重播历史。 */
export function migrateScreens(
  screens: ScreenInput,
  feedByRoom: Record<string, FeedEvent[]>
): void {
  for (const [roomId, feed] of Object.entries(feedByRoom)) {
    const latest: Record<string, { revision: number; seq: number }> = {};
    for (const event of feed) {
      const cur = latest[event.captionId];
      if (!cur || event.revision >= cur.revision) {
        latest[event.captionId] = { revision: event.revision, seq: event.seq };
      }
    }
    baselineScreen(screens.primary, roomId, latest);
    baselineScreen(screens.backup, roomId, latest);
  }
}

export function appendFeedEvent(
  feedByRoom: Record<string, FeedEvent[]>,
  seqByRoom: Record<string, number>,
  roomId: string,
  event: Omit<FeedEvent, 'seq' | 'at'> & { at?: string }
): FeedEvent {
  seqByRoom[roomId] = (seqByRoom[roomId] ?? 0) + 1;
  const full: FeedEvent = { ...event, seq: seqByRoom[roomId], at: event.at ?? new Date().toISOString() };
  if (!feedByRoom[roomId]) feedByRoom[roomId] = [];
  feedByRoom[roomId].push(full);
  return full;
}

/** 直播推送：只投递给在线的屏；可模拟同一条重复推送两遍。 */
export function livePush(
  screens: ScreenInput,
  roomId: string,
  event: FeedEvent,
  options: { duplicate?: boolean } = {}
): { screen: ScreenState; result: ReturnType<typeof enqueue> }[] {
  const results: { screen: ScreenState; result: ReturnType<typeof enqueue> }[] = [];
  for (const screen of [screens.primary, screens.backup]) {
    const room = ensureRoom(screen, roomId);
    if (!room.online) continue;
    results.push({ screen, result: enqueue(room, event, 'live') });
    if (options.duplicate) results.push({ screen, result: enqueue(room, { ...event }, 'live') });
  }
  return results;
}

export function screenOffline(screen: ScreenState, roomId: string): void {
  goOffline(ensureRoom(screen, roomId));
}

export function screenReconnect(screen: ScreenState, roomId: string, feed: FeedEvent[]): FeedEvent[] {
  return reconnect(ensureRoom(screen, roomId), feed);
}

export function screenPause(screen: ScreenState, roomId: string, paused: boolean): void {
  setPaused(ensureRoom(screen, roomId), paused);
}

export function tickScreen(screen: ScreenState, roomId: string): FeedEvent[] {
  return pump(ensureRoom(screen, roomId), 1);
}

/** 译员更新已播字幕版本：对已播过旧版的屏让游标失效。 */
export function publishRevision(
  screens: ScreenInput,
  roomId: string,
  captionId: string,
  newRevision: number
): void {
  for (const screen of [screens.primary, screens.backup]) {
    invalidateCursorAfterRevision(ensureRoom(screen, roomId), captionId, newRevision);
  }
}

/** 两块屏播完后相互对账，各自把漏播补齐。 */
export function reconcileBoth(screens: ScreenInput, roomId: string, feed: FeedEvent[]): boolean {
  const ra = reconcileWithPeer(screens.primary, feed, screens.backup, roomId);
  const rb = reconcileWithPeer(screens.backup, feed, screens.primary, roomId);
  return ra.touched || rb.touched;
}

export function bothCaughtUp(screens: ScreenInput, roomId: string, feedMaxSeq: number): boolean {
  return (
    isCaughtUp(ensureRoom(screens.primary, roomId), feedMaxSeq) &&
    isCaughtUp(ensureRoom(screens.backup, roomId), feedMaxSeq)
  );
}

export { uid };
