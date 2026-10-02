import { $, component$, useSignal, useStore, useVisibleTask$ } from '@builder.io/qwik';
import { Progress } from '@qwik-ui/headless';
import { QueryClient } from '@tanstack/query-core';
import { useForm, zodForm$ } from '@modular-forms/qwik';
import { useSpeakLocale } from 'qwik-speak';
import { z } from 'zod';
import type { DocumentHead } from '@builder.io/qwik-city';
import type { FeedEvent, ScreenState } from '~/screens/engine';
import {
  appendFeedEvent,
  createScreens,
  ensureScreenRooms,
  livePush,
  migrateScreens,
  publishRevision,
  reconcileBoth,
  screenOffline,
  screenPause,
  screenReconnect,
  tickScreen
} from '~/screens/simulation';

type SpeechStatus = 'queued' | 'speaking' | 'done' | 'skipped';
type InterpreterStatus = 'active' | 'handoff' | 'standby';
type Room = { id: string; name: string; topic: string; simultaneousChannels: number };
type Speech = { id: string; roomId: string; speaker: string; delegation: string; language: string; topic: string; plannedSeconds: number; remainingSeconds: number; status: SpeechStatus; updatedAt: string };
type Channel = { id: string; roomId: string; language: string; interpreter: string; status: InterpreterStatus; health: number };
type Term = { id: string; phrase: string; translation: string; language: string; approved: boolean };
type Caption = { id: string; speechId: string; roomId: string; language: string; interpreter: string; text: string; revision: number; at: string };
type Audit = { id: string; at: string; roomId: string; message: string };

interface ConferenceState {
  rooms: Room[];
  activeRoomId: string;
  speechQueue: Speech[];
  channels: Channel[];
  terms: Term[];
  captions: Caption[];
  audits: Audit[];
  lowLatency: boolean;
  /** 每个厅一条 append-only 权威修订流（厅内 seq 单调递增） */
  captionFeed: Record<string, FeedEvent[]>;
  feedSeq: Record<string, number>;
  /** 主、备两块大屏各自的跟播/对账状态（按厅隔离） */
  screens: { primary: ScreenState; backup: ScreenState };
  /** 模拟会场网络：同一条修订连推两遍 */
  dupPush: Record<string, boolean>;
}

const now = new Date().toISOString();
const seed: ConferenceState = {
  rooms: [
    { id: 'hall-a', name: 'A厅 · 全体会议', topic: '全球气候融资', simultaneousChannels: 6 },
    { id: 'hall-b', name: 'B厅 · 技术分会', topic: '人工智能基础设施', simultaneousChannels: 4 }
  ],
  activeRoomId: 'hall-a',
  speechQueue: [
    { id: 'speech-1', roomId: 'hall-a', speaker: 'Amina Diallo', delegation: '塞内加尔', language: '英语', topic: '适应性融资缺口', plannedSeconds: 600, remainingSeconds: 214, status: 'speaking', updatedAt: now },
    { id: 'speech-2', roomId: 'hall-a', speaker: '李明远', delegation: '中国', language: '中文', topic: '绿色基础设施机制', plannedSeconds: 600, remainingSeconds: 600, status: 'queued', updatedAt: now },
    { id: 'speech-3', roomId: 'hall-b', speaker: 'Maria Silva', delegation: '巴西', language: '葡萄牙语', topic: '边缘算力与能源', plannedSeconds: 420, remainingSeconds: 420, status: 'queued', updatedAt: now }
  ],
  channels: [
    { id: 'ch-a-zh', roomId: 'hall-a', language: '中文', interpreter: '周雨', status: 'active', health: 96 },
    { id: 'ch-a-es', roomId: 'hall-a', language: '西班牙语', interpreter: 'Lucía M.', status: 'active', health: 91 },
    { id: 'ch-a-fr', roomId: 'hall-a', language: '法语', interpreter: 'Noah B.', status: 'standby', health: 88 },
    { id: 'ch-b-zh', roomId: 'hall-b', language: '中文', interpreter: '何佳', status: 'active', health: 94 }
  ],
  terms: [
    { id: 'term-1', phrase: 'loss and damage', translation: '损失与损害', language: '中文', approved: true },
    { id: 'term-2', phrase: 'edge inference', translation: '边缘推理', language: '中文', approved: true },
    { id: 'term-3', phrase: 'just transition', translation: '公正转型', language: '中文', approved: false }
  ],
  captions: [
    { id: 'caption-1', speechId: 'speech-1', roomId: 'hall-a', language: '中文', interpreter: '周雨', text: '我们需要把适应资金与可衡量的社区韧性目标绑定。', revision: 2, at: now }
  ],
  captionFeed: {
    // 历史已保存的修订流；大屏状态升级时按最新版 v2 起步，不重播历史
    'hall-a': [
      { seq: 1, captionId: 'caption-1', speechId: 'speech-1', language: '中文', interpreter: '周雨', text: '我们需要把适应资金与可衡量的目标绑定。', revision: 1, at: new Date(Date.now() - 300000).toISOString() },
      { seq: 2, captionId: 'caption-1', speechId: 'speech-1', language: '中文', interpreter: '周雨', text: '我们需要把适应资金与可衡量的社区韧性目标绑定。', revision: 2, at: now }
    ],
    'hall-b': []
  },
  feedSeq: { 'hall-a': 2, 'hall-b': 0 },
  screens: createScreens(),
  dupPush: { 'hall-a': false, 'hall-b': false },
  audits: [
    { id: 'audit-1', at: now, roomId: 'hall-a', message: 'Amina Diallo 开始发言，中文频道由周雨接续' },
    { id: 'audit-2', at: new Date(Date.now() - 90000).toISOString(), roomId: 'hall-a', message: '临时插话申请已插入队列第2位' }
  ],
  lowLatency: false
};

const captionSchema = z.object({ text: z.string().min(1, '字幕不能为空') });
const queueSchema = z.object({
  speaker: z.string().min(2, '请输入发言人'),
  delegation: z.string().min(2, '请输入代表团'),
  language: z.string().min(2),
  topic: z.string().min(3, '请输入议题'),
  plannedSeconds: z.coerce.number().min(60).max(3600)
});
type QueueForm = z.infer<typeof queueSchema>;

function readState(): ConferenceState {
  const fallback = structuredClone(seed);
  fallback.screens = createScreens();
  ensureScreenRooms(fallback.screens, fallback.rooms.map((room) => room.id));
  // 全新进入（含旧数据升级）：大屏没有游标，按已保存的最新版本起步，不重播历史
  migrateScreens(fallback.screens, fallback.captionFeed);
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const saved = JSON.parse(localStorage.getItem('conference-interpretation-v2') ?? 'null') as ConferenceState | null;
    if (!saved) return fallback;
    // 补齐新版本字段（旧存档升级）
    if (!saved.captionFeed) {
      saved.captionFeed = {};
      saved.feedSeq = {};
      for (const caption of saved.captions ?? []) {
        if (!saved.captionFeed[caption.roomId]) saved.captionFeed[caption.roomId] = [];
        const seq = saved.captionFeed[caption.roomId].length + 1;
        saved.captionFeed[caption.roomId].push({
          seq,
          captionId: caption.id,
          speechId: caption.speechId,
          language: caption.language,
          interpreter: caption.interpreter,
          text: caption.text,
          revision: caption.revision,
          at: caption.at
        });
        saved.feedSeq[caption.roomId] = seq;
      }
    }
    if (!saved.screens) {
      saved.screens = createScreens();
      ensureScreenRooms(saved.screens, saved.rooms.map((room) => room.id));
      migrateScreens(saved.screens, saved.captionFeed);
      saved.audits?.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId: saved.activeRoomId, message: '旧数据升级：大屏无游标，按已保存的最新字幕版本起步' });
    }
    for (const room of saved.rooms) {
      if (!saved.screens.primary.rooms[room.id]) ensureScreenRooms(saved.screens, [room.id]);
    }
    saved.dupPush ??= {};
    return saved;
  } catch {
    return fallback;
  }
}

const advanceSpeech$ = $((state: ConferenceState, id: string, status: SpeechStatus) => {
  state.speechQueue = state.speechQueue.map((item) => item.id === id ? { ...item, status, updatedAt: new Date().toISOString() } : item);
  if (status === 'speaking') {
    state.speechQueue = state.speechQueue.map((item) => item.id !== id && item.roomId === state.activeRoomId && item.status === 'speaking' ? { ...item, status: 'done' } : item);
  }
  state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId: state.activeRoomId, message: `发言 ${id} 状态更新为 ${status}` });
});

const addCaption$ = $((state: ConferenceState, speechId: string, text: string) => {
  const speech = state.speechQueue.find((item) => item.id === speechId);
  const channel = state.channels.find((item) => item.roomId === speech?.roomId && item.language === '中文');
  if (!speech || !channel || !text.trim()) return;
  const roomId = speech.roomId;
  const existing = state.captions.find((item) => item.speechId === speechId && item.language === channel.language);
  const revision = (existing?.revision ?? 0) + 1;
  const captionId = existing?.id ?? crypto.randomUUID();
  const at = new Date().toISOString();

  if (existing) {
    state.captions = state.captions.map((item) => item.id === existing.id ? { ...item, text, revision, interpreter: channel.interpreter, at } : item);
  } else {
    state.captions.unshift({ id: captionId, speechId, roomId, language: channel.language, interpreter: channel.interpreter, text, revision: 1, at });
  }

  // 权威修订流追加一版；译员改稿后对已播过旧版的屏令其已播游标失效
  const event = appendFeedEvent(state.captionFeed, state.feedSeq, roomId, {
    captionId,
    speechId,
    language: channel.language,
    interpreter: channel.interpreter,
    text,
    revision
  });
  publishRevision(state.screens, roomId, captionId, revision);
  livePush(state.screens, roomId, event, { duplicate: state.dupPush[roomId] });

  state.audits.unshift({
    id: crypto.randomUUID(),
    at,
    roomId,
    message: existing
      ? `译员修订 ${captionId} 至 v${revision}：已播过旧版的屏游标失效，待重新对账/补播新版`
      : `新字幕 ${captionId} v1 已向主备屏直播推送`
  });
});

export default component$(() => {
  const locale = useSpeakLocale();
  const state = useStore<ConferenceState>(readState());
  const captionLoader = useSignal({ text: '' });
  const [captionForm, { Form: CaptionForm, Field: CaptionField }] = useForm<z.infer<typeof captionSchema>>({
    loader: captionLoader,
    validate: zodForm$(captionSchema)
  });
  const queueLoader = useSignal<QueueForm>({ speaker: '', delegation: '', language: '英语', topic: '', plannedSeconds: 300 });
  const [queueForm, { Form: QueueForm, Field: QueueField }] = useForm<QueueForm>({
    loader: queueLoader,
    validate: zodForm$(queueSchema)
  });

  useVisibleTask$(({ track }) => {
    track(() => state);
    localStorage.setItem('conference-interpretation-v2', JSON.stringify(state));
  });

  // 大屏跟播时钟：每 1.2 秒各屏按 seq 播一条；暂停的屏自然不动。
  useVisibleTask$(() => {
    const timer = setInterval(() => {
      const roomId = state.activeRoomId;
      tickScreen(state.screens.primary, roomId);
      tickScreen(state.screens.backup, roomId);
      const feedMaxSeq = state.feedSeq[roomId] ?? 0;
      // 两块屏跟同一厅都播完后自动比对差异，把漏播的补进各自待播队列
      const a = state.screens.primary.rooms[roomId];
      const b = state.screens.backup.rooms[roomId];
      if (a && b && a.pending.length === 0 && b.pending.length === 0 && !a.paused && !b.paused && a.online && b.online) {
        const needCheck = a.reconciledThrough < feedMaxSeq || b.reconciledThrough < feedMaxSeq;
        if (needCheck) {
          const touched = reconcileBoth(state.screens, roomId, state.captionFeed[roomId] ?? []);
          if (touched) {
            state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId, message: '两块屏播完自动对账：发现漏播/作废差异，已补入待播' });
          }
        }
      }
    }, 1200);
    return () => clearInterval(timer);
  });

  const activeRoom = () => state.rooms.find((room) => room.id === state.activeRoomId) ?? state.rooms[0];
  const roomQueue = () => state.speechQueue.filter((item) => item.roomId === state.activeRoomId);
  const roomChannels = () => state.channels.filter((item) => item.roomId === state.activeRoomId);
  const currentSpeech = () => roomQueue().find((item) => item.status === 'speaking');

  const selectRoom$ = $((roomId: string) => {
    state.activeRoomId = roomId;
    state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId, message: `切换到 ${state.rooms.find((room) => room.id === roomId)?.name}` });
  });

  const addSpeech$ = $((values: QueueForm) => {
    state.speechQueue.push({ id: crypto.randomUUID(), roomId: state.activeRoomId, ...values, remainingSeconds: values.plannedSeconds, status: 'queued', updatedAt: new Date().toISOString() });
    state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId: state.activeRoomId, message: `${values.speaker} 已加入发言队列` });
  });

  const handoff$ = $((channelId: string) => {
    state.channels = state.channels.map((channel) => channel.id === channelId ? { ...channel, status: 'handoff' } : channel);
    state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId: state.activeRoomId, message: `${channelId} 启动译员交接，原译文版本已冻结` });
  });

  const completeHandoff$ = $((channelId: string, interpreter: string) => {
    state.channels = state.channels.map((channel) => channel.id === channelId ? { ...channel, interpreter, status: 'active', health: Math.min(100, channel.health + 2) } : channel);
    state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId: state.activeRoomId, message: `${interpreter} 接续 ${channelId}，后续字幕归属新译员` });
  });

  const publishCaption$ = $(async (values: z.infer<typeof captionSchema>) => {
    const speech = state.speechQueue.find((item) => item.roomId === state.activeRoomId && item.status === 'speaking');
    if (!speech) return;
    const queryClient = new QueryClient();
    const confirmed = await queryClient.fetchQuery({
      queryKey: ['caption-publish', speech.id, values.text],
      queryFn: async () => values.text === values.text.trim(),
      staleTime: 0
    });
    if (confirmed) await addCaption$(state, speech.id, values.text);
  });

  const approveTerm$ = $((id: string) => {
    state.terms = state.terms.map((term) => term.id === id ? { ...term, approved: true } : term);
    state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId: state.activeRoomId, message: `术语已批准：${state.terms.find((term) => term.id === id)?.phrase}` });
  });

  // —— 主备大屏跟播控制 ——
  const toggleScreenNetwork$ = $((id: 'primary' | 'backup') => {
    const roomId = state.activeRoomId;
    const room = state.screens[id].rooms[roomId];
    if (!room) return;
    const label = id === 'primary' ? '主屏' : '备屏';
    if (room.online) {
      screenOffline(state.screens[id], roomId);
      state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId, message: `${label}断网：直播修订暂存厅内，本屏待播队列与游标保留` });
    } else {
      const filled = screenReconnect(state.screens[id], roomId, state.captionFeed[roomId] ?? []);
      state.audits.unshift({
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        roomId,
        message: filled.length > 0
          ? `${label}网络恢复：按序号补齐 ${filled.length} 条攒下修订，补播走完前直播新修订排在后面`
          : `${label}网络恢复：无缺失修订`
      });
    }
  });

  const toggleScreenPause$ = $((id: 'primary' | 'backup') => {
    const room = state.screens[id].rooms[state.activeRoomId];
    if (!room) return;
    screenPause(state.screens[id], state.activeRoomId, !room.paused);
    state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId: state.activeRoomId, message: `${id === 'primary' ? '主屏' : '备屏'}主持人${room.paused ? '恢复' : '暂停'}（只管本屏），待播从暂停点继续` });
  });

  const reconcileNow$ = $(() => {
    const roomId = state.activeRoomId;
    const touched = reconcileBoth(state.screens, roomId, state.captionFeed[roomId] ?? []);
    state.audits.unshift({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      roomId,
      message: touched ? '手动对账完成：漏播已补入待播，旧修订差异已记录' : '手动对账完成：两块屏内容一致，无差异'
    });
  });

  const resetScreensToLatest$ = $(() => {
    // 演示“旧数据升级”：清掉屏状态，按当前最新保存版本重新起步
    state.screens = createScreens();
    ensureScreenRooms(state.screens, state.rooms.map((room) => room.id));
    migrateScreens(state.screens, state.captionFeed);
    state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId: state.activeRoomId, message: '大屏状态重置为升级场景：无历史游标，按各厅最新版本起步' });
  });

  return (
    <main class={`conference-shell ${state.lowLatency ? 'low-latency' : ''}`}>
      <header class="hero">
        <div><span class="pill">{locale.lang}</span><h1>同声传译与发言队列</h1><p>{activeRoom().name} · {activeRoom().topic}</p></div>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <select value={state.activeRoomId} onChange$={(event) => selectRoom$((event.target as HTMLSelectElement).value)}>{state.rooms.map((room) => <option value={room.id}>{room.name}</option>)}</select>
          <button class="secondary" onClick$={() => state.lowLatency = !state.lowLatency}>{state.lowLatency ? '退出低延迟' : '低延迟模式'}</button>
        </div>
      </header>

      <section class="grid">
        <article class="panel">
          <div style="display:flex;justify-content:space-between;align-items:center"><h2>发言队列</h2><span class="pill">{roomQueue().length} 条 · {activeRoom().simultaneousChannels} 个同传频道</span></div>
          {roomQueue().map((speech, index) => (
            <div class={`queue-row ${speech.status === 'speaking' ? 'active' : ''}`} key={speech.id}>
              <strong>#{index + 1}</strong>
              <div><b>{speech.speaker}</b><div style="color:#638087;font-size:13px">{speech.delegation} · {speech.language} · {speech.topic}</div></div>
              <span class="pill">{speech.status}</span>
              <div style="display:flex;gap:6px">
                {speech.status === 'queued' && <button onClick$={() => advanceSpeech$(state, speech.id, 'speaking')}>开始</button>}
                {speech.status === 'speaking' && <><button onClick$={() => advanceSpeech$(state, speech.id, 'done')}>结束</button><button class="secondary" onClick$={() => speech.remainingSeconds = Math.max(0, speech.remainingSeconds - 60)}>减1分钟</button></>}
                {speech.status === 'queued' && <button class="danger" onClick$={() => advanceSpeech$(state, speech.id, 'skipped')}>跳过</button>}
              </div>
            </div>
          ))}
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:18px">
            <QueueForm onSubmit$={addSpeech$}>
              <QueueField name="speaker">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="发言人" />}</QueueField>
              <QueueField name="delegation">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="代表团" />}</QueueField>
              <QueueField name="topic">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="议题" />}</QueueField>
              <QueueField name="plannedSeconds" type="number">{(field, props) => <input {...props} type="number" value={field.value} onInput$={(event) => field.value = Number((event.target as HTMLInputElement).value)} placeholder="计划秒数" />}</QueueField>
              <button type="submit">加入队列</button>
            </QueueForm>
          </div>
        </article>

        <aside class="panel">
          <h2>频道与译员</h2>
          {roomChannels().map((channel) => (
            <div style="padding:12px 0;border-bottom:1px solid #e6efee" key={channel.id}>
              <div style="display:flex;justify-content:space-between"><b>{channel.language} · {channel.interpreter}</b><span class="pill">{channel.status}</span></div>
              <div class="decorative" style="margin:8px 0"><Progress.Root value={channel.health} max={100} /></div>
              <div style="display:flex;gap:8px"><button class="secondary" onClick$={() => handoff$(channel.id)}>开始交接</button>{channel.status === 'handoff' && <button onClick$={() => completeHandoff$(channel.id, `替补译员-${channel.language}`)}>完成交接</button>}</div>
            </div>
          ))}
          <h3>实时字幕修正</h3>
          {currentSpeech() ? <CaptionForm onSubmit$={publishCaption$}><CaptionField name="text">{(field, props) => <textarea {...props} rows={3} value={field.value} onInput$={(event) => field.value = (event.target as HTMLTextAreaElement).value} placeholder="输入或修正当前字幕" />}</CaptionField><button type="submit">提交新版字幕</button></CaptionForm> : <p>当前没有发言中的代表。</p>}
          {state.captions.filter((caption) => caption.roomId === state.activeRoomId).map((caption) => <div style="margin-top:10px;padding:10px;background:#f1f8f7;border-radius:10px" key={caption.id}><b>{caption.interpreter} · v{caption.revision}</b><p>{caption.text}</p></div>)}
        </aside>
      </section>

      <section class="grid" style="margin-top:18px">
        <article class="panel">
          <h2>术语库</h2>
          {state.terms.map((term) => <div class="queue-row" key={term.id}><span/><div><b>{term.phrase}</b><div>{term.translation} · {term.language}</div></div><span class="pill">{term.approved ? '已批准' : '待审'}</span><button disabled={term.approved} onClick$={() => approveTerm$(term.id)}>批准</button></div>)}
        </article>
        <article class="panel">
          <h2>操作与交接时间线</h2>
          {state.audits.filter((audit) => audit.roomId === state.activeRoomId).slice(0, 10).map((audit) => <div style="padding:10px 0;border-bottom:1px solid #e6efee" key={audit.id}><small>{new Date(audit.at).toLocaleTimeString()}</small><div>{audit.message}</div></div>)}
        </article>
      </section>

      <section style="margin-top:18px">
        <article class="panel">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
            <h2 style="margin:0">主备大屏 · 修订序号跟播与对账</h2>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <label class="pill" style="gap:6px;cursor:pointer">
                <input type="checkbox" style="width:auto" checked={!!state.dupPush[state.activeRoomId]} onChange$={() => (state.dupPush[state.activeRoomId] = !state.dupPush[state.activeRoomId])} />
                模拟同条重复推送（播两遍→只播一次）
              </label>
              <button class="secondary" onClick$={reconcileNow$}>立即两块屏对账</button>
              <button class="secondary" onClick$={resetScreensToLatest$}>模拟旧数据升级（无游标）</button>
            </div>
          </div>
          <p style="color:#59747b;font-size:13px;margin:8px 0 14px">
            修订按厅内序号 #seq 投递，游标按每条字幕的 v 版本推进；重连补齐走 catch-up，主持人暂停只管本屏，两屏播完自动比对漏播。
          </p>
          <div class="screen-grid">
            {(['primary', 'backup'] as const).map((id) => {
              const room = state.screens[id].rooms[state.activeRoomId];
              if (!room) return <div />;
              const lastPlayed = room.played[0];
              const feedEvent = lastPlayed ? (state.captionFeed[state.activeRoomId] ?? []).find((event) => event.seq === lastPlayed.seq) : undefined;
              const cursorEntries = Object.entries(room.cursors)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([captionId, rev]) => {
                  const short = captionId.split('-').slice(-1)[0].slice(0, 4);
                  return room.cursorsValid[captionId] === false ? `…${short}⚠v${rev}` : `…${short}:v${rev}`;
                });
              return (
                <div class={`screen-card ${room.online ? '' : 'offline'} ${room.paused ? 'paused' : ''}`} key={id}>
                  <div class="screen-head">
                    <b>{id === 'primary' ? '主屏' : '备屏'}</b>
                    <span class="pill">{room.online ? '在线' : '断网'}</span>
                    {room.paused && <span class="pill" style="background:#fde9d3;color:#9a5b13">本屏暂停</span>}
                    {room.catchingUp && <span class="pill" style="background:#e6ecfd;color:#34489a">补播中</span>}
                  </div>
                  <div class="screen-stage">
                    {feedEvent ? (
                      <>
                        <div class="screen-now">#{feedEvent.seq} · {feedEvent.interpreter} · v{feedEvent.revision}</div>
                        <div class="screen-text">{feedEvent.text}</div>
                      </>
                    ) : <div class="screen-text" style="color:#8aa3a7">（等待本厅修订…旧数据升级时从最新版起步，不重播历史）</div>}
                  </div>
                  <div style="display:flex;gap:8px;margin:10px 0">
                    <button onClick$={() => toggleScreenNetwork$(id)}>{room.online ? '模拟断网' : '网络恢复·补齐'}</button>
                    <button class="secondary" onClick$={() => toggleScreenPause$(id)}>{room.paused ? '恢复本屏' : '暂停本屏'}</button>
                  </div>
                  <div style="font-size:12px;color:#59747b;margin-bottom:6px">游标：{cursorEntries.length > 0 ? cursorEntries.join('  ') : '无（按最新保存版本起步）'}</div>
                  <div class="screen-sub"><b>待播队列（{room.pending.length}）</b>
                    {room.pending.length === 0 ? <small>空</small> : room.pending.slice(0, 5).map((event, idx) => (
                      <span class="queue-chip" key={`${event.seq}-${idx}`}>#{event.seq} v{event.revision}</span>
                    ))}
                  </div>
                  <div class="screen-sub"><b>对账差异（{room.diffs.length}）</b>
                    {room.diffs.length === 0 ? <small>无</small> : room.diffs.slice(0, 4).map((diff) => (
                      <div class={`diff-line diff-${diff.kind}`} key={diff.id}>
                        <span class="diff-tag">{diff.kind === 'stale' ? '作废' : diff.kind === 'dup' ? '重复' : diff.kind === 'gap-filled' ? '补齐' : diff.kind === 'peer-filled' ? '对端补缺' : '游标失效'}</span>
                        {diff.detail}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <h3 style="margin:16px 0 8px">本厅权威修订流（共 {state.feedSeq[state.activeRoomId] ?? 0} 个序号）</h3>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            {(state.captionFeed[state.activeRoomId] ?? []).slice(-14).map((event) => (
              <span class="feed-chip" key={event.seq}>#{event.seq} v{event.revision} · {event.text.slice(0, 10)}…</span>
            ))}
          </div>
        </article>
      </section>
    </main>
  );
});

export const head: DocumentHead = {
  title: '国际会议同声传译控制台',
  meta: [{ name: 'description', content: '发言队列、多语种频道、术语、译员交接与实时字幕修正原型' }]
};
