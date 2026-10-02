import { component$, useStore, useVisibleTask$, $ } from '@builder.io/qwik';
import type { DocumentHead } from '@builder.io/qwik-city';
import {
  createScreen,
  startFollowing,
  createHallSource,
  publishRevision,
  bumpVersion,
  feedRevision,
  pauseScreen,
  resumeScreen,
  setOnline,
  catchUp,
  reconcile,
  pumpOne,
  bootstrap,
  type ScreenId,
  type ScreenState,
  type HallSource
} from '~/lib/reconcile';

type ScreenCardProps = {
  screen: ScreenState;
  label: string;
  onToggleOnline$: () => void;
  onTogglePause$: () => void;
  onCatchUp$: () => void;
  onUpgrade$: () => void;
};

const ScreenCard = component$<ScreenCardProps>((props) => {
  const s = props.screen;
  return (
    <article class={`screen-card ${s.paused ? 'paused' : ''} ${!s.online ? 'offline' : ''}`}>
      <div class="screen-head">
        <div>
          <h2>{props.label}</h2>
          <div class="screen-meta">
            <span class="pill">厅 {s.hallId}</span>
            <span class="pill">v{s.version}</span>
            <span class="pill">游标 {s.cursor ?? '—'}</span>
          </div>
        </div>
        <div class="badges">
          {!s.online && <span class="badge offline">离线</span>}
          {s.online && s.paused && <span class="badge paused">已暂停</span>}
          {s.online && !s.paused && s.catchingUp && <span class="badge catching">补播中</span>}
          {s.online && !s.paused && !s.catchingUp && <span class="badge live">跟播中</span>}
        </div>
      </div>

      <div class="screen-text">
        {s.current ? (
          <>
            <div class="rev-tag">#{s.current.seq}</div>
            <p>{s.current.text}</p>
          </>
        ) : (
          <p class="empty">暂无字幕</p>
        )}
      </div>

      <div class="screen-stats">
        <span>待播 <b>{s.pending.length}</b></span>
        <span>已播 <b>{s.played.length}</b></span>
      </div>

      <div class="screen-actions">
        <button class="secondary" onClick$={props.onToggleOnline$}>{s.online ? '置离线' : '置在线'}</button>
        <button class="secondary" onClick$={props.onTogglePause$}>{s.paused ? '恢复' : '暂停'}</button>
        <button onClick$={props.onCatchUp$}>补齐</button>
        <button class="secondary" onClick$={props.onUpgrade$}>旧数据升级</button>
      </div>

      {s.diffs.length > 0 && (
        <div class="screen-diffs">
          <h4>对账差异</h4>
          {s.diffs.slice(0, 6).map((d) => (
            <div class={`diff-row kind-${d.kind}`} key={d.id}>
              <span class="diff-kind">{d.kind}</span>
              <span class="diff-msg">{d.message}</span>
            </div>
          ))}
        </div>
      )}
    </article>
  );
});

export default component$(() => {
  const store = useStore(() => {
    const src = createHallSource('hall-a');
    const main = createScreen('main', 'hall-a');
    const backup = createScreen('backup', 'hall-a');
    startFollowing(main, 'hall-a');
    startFollowing(backup, 'hall-a');
    const seeds = [
      '各位代表，现在开始审议气候融资议题。',
      '请发言代表控制在五分钟以内。',
      '注意：适应资金缺口部分已修订。'
    ];
    for (const text of seeds) {
      const rev = publishRevision(src, text);
      feedRevision(main, rev);
      feedRevision(backup, rev);
    }
    return { hallId: 'hall-a', src, main, backup, draft: '' };
  });

  // 慢动作补播：每 800ms 播一条待播修订，让“补播期间新到的排在后面”可观察
  useVisibleTask$(() => {
    const timer = setInterval(() => {
      if (store.main.online && !store.main.paused) pumpOne(store.main);
      if (store.backup.online && !store.backup.paused) pumpOne(store.backup);
    }, 800);
    return () => clearInterval(timer);
  });

  const publish$ = $((text: string) => {
    if (!text.trim()) return;
    const rev = publishRevision(store.src, text.trim());
    if (store.main.online) feedRevision(store.main, rev);
    if (store.backup.online) feedRevision(store.backup, rev);
  });

  const republishLast$ = $(() => {
    const last = store.src.revisions[store.src.revisions.length - 1];
    if (!last) return;
    if (store.main.online) feedRevision(store.main, last);
    if (store.backup.online) feedRevision(store.backup, last);
  });

  const bumpVersion$ = $(() => {
    bumpVersion(store.src);
    const rev = publishRevision(store.src, '（字幕版本已更新，请重新跟播）');
    if (store.main.online) feedRevision(store.main, rev);
    if (store.backup.online) feedRevision(store.backup, rev);
  });

  const toggleOnline$ = $((id: ScreenId) => {
    const s = id === 'main' ? store.main : store.backup;
    setOnline(s, !s.online);
  });

  const togglePause$ = $((id: ScreenId) => {
    const s = id === 'main' ? store.main : store.backup;
    if (s.paused) resumeScreen(s);
    else pauseScreen(s);
  });

  const catchUp$ = $((id: ScreenId) => {
    const s = id === 'main' ? store.main : store.backup;
    setOnline(s, true);
    catchUp(s, store.src);
  });

  const upgrade$ = $((id: ScreenId) => {
    const s = id === 'main' ? store.main : store.backup;
    s.started = false;
    s.cursor = null;
    s.played = [];
    s.pending = [];
    s.current = null;
    s.version = store.src.version;
    bootstrap(s, store.src);
  });

  const reconcile$ = $(() => {
    reconcile(store.main, store.backup);
  });

  const switchHall$ = $((hallId: string) => {
    store.hallId = hallId;
    store.src = createHallSource(hallId);
    startFollowing(store.main, hallId);
    startFollowing(store.backup, hallId);
  });

  // 场景快捷操作
  const scenario$ = $((kind: string) => {
    if (kind === 'split') {
      // 网络抖动：备屏离线，攒两条，再上线补齐
      setOnline(store.backup, false);
      publishRevision(store.src, '临时插话：岛屿国家代表申请补充。');
      publishRevision(store.src, '修正：适应资金缺口数字已更新。');
      setOnline(store.backup, true);
      catchUp(store.backup, store.src);
    } else if (kind === 'dup') {
      const rev = publishRevision(store.src, '重复推送测试');
      if (store.main.online) feedRevision(store.main, rev);
      if (store.backup.online) feedRevision(store.backup, rev);
      if (store.main.online) feedRevision(store.main, rev);
      if (store.backup.online) feedRevision(store.backup, rev);
    } else if (kind === 'pause') {
      pauseScreen(store.main);
      const rev = publishRevision(store.src, '暂停期间攒下的字幕');
      if (store.main.online) feedRevision(store.main, rev);
      if (store.backup.online) feedRevision(store.backup, rev);
    } else if (kind === 'version') {
      bumpVersion(store.src);
      const rev = publishRevision(store.src, '（字幕版本已更新，请重新跟播）');
      if (store.main.online) feedRevision(store.main, rev);
      if (store.backup.online) feedRevision(store.backup, rev);
    } else if (kind === 'upgrade') {
      store.main.started = false;
      store.main.cursor = null;
      store.main.played = [];
      store.main.pending = [];
      store.main.current = null;
      store.main.version = store.src.version;
      bootstrap(store.main, store.src);
    }
  });

  const allDiffs = [...store.main.diffs, ...store.backup.diffs]
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 12);

  return (
    <main class="conference-shell">
      <header class="hero">
        <div>
          <span class="pill">主备大屏 · 修订序号跟播</span>
          <h1>同传字幕主备屏跟播与对账</h1>
          <p>断网恢复后按修订序号补齐，同序号只播一次，漏播对账补上</p>
        </div>
        <div class="hero-actions">
          <select value={store.hallId} onChange$={(e) => switchHall$((e.target as HTMLSelectElement).value)}>
            <option value="hall-a">A厅 · 全体会议</option>
            <option value="hall-b">B厅 · 技术分会</option>
          </select>
          <a class="button-link" href="/">返回控制台</a>
        </div>
      </header>

      <section class="scenario-bar">
        <span class="scenario-label">场景演示：</span>
        <button class="secondary" onClick$={() => scenario$('split')}>网络抖动补齐</button>
        <button class="secondary" onClick$={() => scenario$('dup')}>重复推送去重</button>
        <button class="secondary" onClick$={() => scenario$('pause')}>暂停攒播</button>
        <button class="secondary" onClick$={() => scenario$('version')}>字幕版本更新</button>
        <button class="secondary" onClick$={() => scenario$('upgrade')}>旧数据升级</button>
      </section>

      <section class="screen-grid">
        <ScreenCard
          screen={store.main}
          label="主屏"
          onToggleOnline$={() => toggleOnline$('main')}
          onTogglePause$={() => togglePause$('main')}
          onCatchUp$={() => catchUp$('main')}
          onUpgrade$={() => upgrade$('main')}
        />
        <ScreenCard
          screen={store.backup}
          label="备屏"
          onToggleOnline$={() => toggleOnline$('backup')}
          onTogglePause$={() => togglePause$('backup')}
          onCatchUp$={() => catchUp$('backup')}
          onUpgrade$={() => upgrade$('backup')}
        />
      </section>

      <section class="grid" style={{ marginTop: '18px' }}>
        <article class="panel">
          <h2>发布修订</h2>
          <p class="hint">译员发布一条新修订（seq 递增），在线的屏会收到并按序跟播。</p>
          <div class="publish-row">
            <input
              value={store.draft}
              onInput$={(e) => (store.draft = (e.target as HTMLInputElement).value)}
              placeholder="输入字幕文本…"
              onKeyDown$={(e) => { if (e.key === 'Enter') { publish$(store.draft); store.draft = ''; } }}
            />
            <button onClick$={() => { publish$(store.draft); store.draft = ''; }}>发布修订</button>
          </div>
          <div class="publish-actions">
            <button class="secondary" onClick$={republishLast$}>重发上一条（测去重）</button>
            <button class="secondary" onClick$={bumpVersion$}>译员更新字幕版本</button>
            <button onClick$={reconcile$}>主备对账补播</button>
          </div>

          <h3>源修订队列（{store.src.hallId} · v{store.src.version}）</h3>
          <div class="source-list">
            {store.src.revisions.slice(-8).reverse().map((r) => (
              <div class="source-row" key={r.id}>
                <span class="pill">#{r.seq}</span>
                <span class="source-text">{r.text}</span>
                <span class="source-time">{new Date(r.at).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        </article>

        <article class="panel">
          <h2>对账与差异时间线</h2>
          <p class="hint">两块屏跟同一厅播完即比对差异，漏播的补上；作废、去重、版本重置都记在这里。</p>
          {allDiffs.length === 0 ? (
            <p class="empty">暂无差异记录。</p>
          ) : (
            allDiffs.map((d) => (
              <div class={`diff-row kind-${d.kind}`} key={d.id}>
                <span class="diff-screen">{d.screen === 'main' ? '主屏' : '备屏'}</span>
                <span class="diff-kind">{d.kind}</span>
                <span class="diff-msg">{d.message}</span>
                <span class="diff-time">{new Date(d.at).toLocaleTimeString()}</span>
              </div>
            ))
          )}
        </article>
      </section>

      <style>{`
        .hero-actions { display:flex; gap:12px; align-items:center; }
        .button-link { display:inline-flex; align-items:center; border-radius:9px; padding:8px 12px; background:#e1eeee; color:#18565a; text-decoration:none; font-size:14px; }
        .scenario-bar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:16px; }
        .scenario-label { color:#59747b; font-size:14px; }
        .screen-grid { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
        .screen-card { background:#fff; border:1px solid #d5e5e3; border-radius:16px; box-shadow:0 12px 28px rgba(28,79,80,.07); padding:18px; display:flex; flex-direction:column; gap:12px; }
        .screen-card.offline { opacity:.72; }
        .screen-card.paused { border-color:#e0a13c; }
        .screen-head { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; }
        .screen-head h2 { margin:0; font-size:20px; }
        .screen-meta { display:flex; gap:6px; margin-top:6px; flex-wrap:wrap; }
        .badges { display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
        .badge { border-radius:999px; padding:3px 10px; font-size:12px; font-weight:600; }
        .badge.live { background:#e2f3f1; color:#086764; }
        .badge.catching { background:#fff3e0; color:#b25e09; }
        .badge.paused { background:#fdf1e0; color:#b25e09; }
        .badge.offline { background:#fde8e6; color:#c2413b; }
        .screen-text { background:#f1f8f7; border-radius:12px; padding:18px; min-height:110px; display:flex; flex-direction:column; gap:8px; }
        .screen-text .rev-tag { align-self:flex-start; background:#0d7772; color:#fff; border-radius:6px; padding:2px 8px; font-size:12px; }
        .screen-text p { margin:0; font-size:20px; line-height:1.5; }
        .screen-text .empty { color:#8aa6a9; font-size:15px; }
        .screen-stats { display:flex; gap:18px; color:#59747b; font-size:14px; }
        .screen-stats b { color:#102f3a; font-size:16px; }
        .screen-actions { display:flex; gap:8px; flex-wrap:wrap; }
        .screen-actions button { font-size:13px; padding:7px 10px; }
        .screen-diffs { border-top:1px solid #e6efee; padding-top:10px; }
        .screen-diffs h4 { margin:0 0 8px; font-size:13px; color:#59747b; }
        .diff-row { display:flex; gap:8px; align-items:baseline; padding:6px 0; border-bottom:1px solid #f0f6f5; font-size:13px; }
        .diff-kind { font-weight:600; color:#086764; flex-shrink:0; }
        .diff-screen { font-weight:600; color:#18565a; flex-shrink:0; }
        .diff-msg { color:#3c5a5f; flex:1; }
        .diff-time { color:#8aa6a9; font-size:12px; flex-shrink:0; }
        .kind-stale .diff-kind { color:#c2413b; }
        .kind-duplicate .diff-kind { color:#b25e09; }
        .kind-version-reset .diff-kind { color:#6d28d9; }
        .kind-missing .diff-kind { color:#086764; }
        .kind-upgrade .diff-kind { color:#0e7490; }
        .hint { color:#59747b; font-size:13px; margin:0 0 10px; }
        .publish-row { display:flex; gap:8px; }
        .publish-actions { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }
        .publish-actions button { font-size:13px; }
        .source-list { margin-top:8px; max-height:260px; overflow:auto; }
        .source-row { display:flex; gap:8px; align-items:center; padding:6px 0; border-bottom:1px solid #f0f6f5; font-size:13px; }
        .source-text { flex:1; color:#3c5a5f; }
        .source-time { color:#8aa6a9; font-size:12px; }
        @media(max-width:900px){ .screen-grid{grid-template-columns:1fr} }
      `}</style>
    </main>
  );
});

export const head: DocumentHead = {
  title: '主备大屏修订序号跟播与对账',
  meta: [{ name: 'description', content: '主备大屏按修订序号跟播、断网补齐、去重、暂停与对账补播原型' }]
};
