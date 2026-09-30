/**
 * 游戏模式 HUD — Host 半（部署级插件，随 dsh 启动自动挂载）。
 *
 * 与动态插件版的差异：
 *  - 不再使用 harness.handle：RPC 走 ctx.connection.rpc.handle('/game-mode', ...)
 *    （dsh-client-connection 提供的通用通道，Client 半用 connection.rpc.call 调用）
 *  - 官网余额用 Node 原生 fetch（部署级插件无沙箱限制，不再依赖 web-fetch-http provider）
 *  - 运行在 host 平面，tokenMeter/agents/agentPresets/fs/timer/sandboxPolicy 全部可用
 */

export const name = 'game-mode-hud';

export const inject = [
  'agents',
  'tokenMeter',
  'agentPresets',
  'fs',
  'timer',
  'sandboxPolicy'
];

export function apply(ctx) {
  const tokenMeter = ctx.tokenMeter;
  const agentsSvc = ctx.agents;
  const presets = ctx.agentPresets;
  const fsSvc = ctx.fs;
  const sandboxPolicy = ctx.sandboxPolicy;
  const timerSvc = ctx.timer;

  // ---------- 开机探针 ----------
  // 部署级插件的 host 半只在进程启动时 import/apply（改文件不会热更新），
  // 因此用一个落盘探针确认 apply 真的执行过，并记录各依赖服务的可用性与注册结果。
  const boot = { at: new Date().toISOString(), pid: typeof process !== 'undefined' ? process.pid : null, services: {}, channel: 'pending' };
  async function writeBoot(extra) {
    try {
      Object.assign(boot, extra || {});
      const cwd = sandboxPolicy && sandboxPolicy.workspaceRoot ? sandboxPolicy.workspaceRoot : undefined;
      const t = await fsSvc.resolve('.game-hud-boot.json', cwd ? { cwd } : undefined);
      await fsSvc.writeText(t, JSON.stringify(boot, null, 1));
    } catch (e) { /* 探针失败不影响主功能 */ }
  }
  for (const n of ['connection', 'agents', 'tokenMeter', 'agentPresets', 'fs', 'timer', 'sandboxPolicy', 'webServer', 'llm']) {
    try { boot.services[n] = ctx.get(n) === undefined ? 'MISSING' : 'OK'; } catch (e) { boot.services[n] = 'ERR'; }
  }
  writeBoot({});

  // ---------- 磁盘持久化（设置参数 + HUD 窗口 + 用量累计，升级/重启不丢） ----------
  const STATE_FILE = '.game-mode-state.json';
  let stateTarget = null;
  async function statePath() {
    if (stateTarget) return stateTarget;
    const cwd = sandboxPolicy ? sandboxPolicy.workspaceRoot : undefined;
    stateTarget = await fsSvc.resolve(STATE_FILE, cwd ? { cwd } : undefined);
    return stateTarget;
  }
  async function loadStateFile() {
    try {
      const t = await statePath();
      const text = await fsSvc.readText(t);
      return JSON.parse(text);
    } catch (e) {
      return null; // 文件不存在或损坏：用默认值
    }
  }
  async function saveStateFile(obj) {
    try {
      const t = await statePath();
      await fsSvc.writeText(t, JSON.stringify(obj, null, 2));
    } catch (e) {
      console.error('[game-mode] 保存状态失败:', e && e.message || String(e));
    }
  }

  // ---------- 游戏配置（内存态，HUD 可调，磁盘持久化） ----------
  // 官方 2026 起按空闲/高峰双档计价（元 / 1M tokens）。默认值取 deepseek-flash 一列：
  //   缓存未命中输入 空闲 1 / 高峰 2；缓存命中 空闲 0.02 / 高峰 0.04；输出 空闲 4 / 高峰 8。
  // 优惠（空闲）时段：北京时间 00:30–08:30，其余为高峰。缓存写入按未命中输入价计。
  const config = {
    budget: 50,              // 总预算（元）
    priceInputOff: 1,        // 元 / 1M：空闲 缓存未命中输入（含缓存写入）
    priceInputPeak: 2,       // 元 / 1M：高峰 缓存未命中输入（含缓存写入）
    priceCacheOff: 0.02,     // 元 / 1M：空闲 缓存命中读取
    priceCachePeak: 0.04,    // 元 / 1M：高峰 缓存命中读取
    priceOutputOff: 4,       // 元 / 1M：空闲 输出
    priceOutputPeak: 8,      // 元 / 1M：高峰 输出
    contextWindow: 1000000,  // 回退上下文窗口（真实值取自 session.requestContext()）
    compactThreshold: 0.65,  // 红条达到该比例即自动压缩
    followOfficial: true,    // 总预算自动跟随官网真实余额（需 API Key；关闭后按手填值）
    forceCompact: false,     // 手动武装压缩
    apiKey: ''               // 官网 API Key（仅本地磁盘存储，不回传明文给页面）
  };
  const num = (v, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return undefined;
    return Math.min(max, Math.max(min, n));
  };

  // ---------- 时段与计价 ----------
  const OFF_PEAK_START_MIN = 30;        // 00:30（北京时间）
  const OFF_PEAK_END_MIN = 8 * 60 + 30; // 08:30（北京时间）
  // 旧状态文件没有费用字段时，用高峰档样本时刻回估算历史花费（北京 12:00 = UTC 04:00）。
  const PEAK_SAMPLE_AT = Date.UTC(2026, 0, 1, 4, 0, 0);
  function bjMinutesOf(at) {
    const d = new Date(at);
    return (d.getUTCHours() * 60 + d.getUTCMinutes() + 8 * 60) % 1440;
  }
  function isOffPeak(at) {
    const m = bjMinutesOf(at === undefined ? Date.now() : at);
    return m >= OFF_PEAK_START_MIN && m < OFF_PEAK_END_MIN;
  }
  function priceAt(at) {
    return isOffPeak(at)
      ? { input: config.priceInputOff, cacheRead: config.priceCacheOff, output: config.priceOutputOff }
      : { input: config.priceInputPeak, cacheRead: config.priceCachePeak, output: config.priceOutputPeak };
  }
  /** 单次调用费用（元）：按调用发生时刻的时段计价，缓存写入按未命中输入价。 */
  function costOf(u, at) {
    const p = priceAt(at);
    const missTokens = (u.inputTokens || u.input || 0) + (u.cacheWriteTokens || u.cacheWrite || 0);
    const hitTokens = u.cacheReadTokens || u.cacheRead || 0;
    const outTokens = u.outputTokens || u.output || 0;
    return (missTokens / 1e6) * p.input + (hitTokens / 1e6) * p.cacheRead + (outTokens / 1e6) * p.output;
  }

  // ---------- 记账 ----------
  // spent 按每次调用发生时的时段累加（时段切换后历史费用不变，新调用按新价）。
  const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, spent: 0 });
  const usageBySession = new Map();
  const totals = zero();
  const compactStats = { count: 0, lastAt: 0, savedTokens: 0 };
  // 用量落盘防抖（每次计费调用都写盘太重，3 秒合并一次）
  const persistDebounced = timerSvc ? timerSvc.debounce(() => persistState(), 3000) : null;

  // ---------- 官网余额（官方 GET /user/balance；鉴权只用 Authorization: Bearer） ----------
  // 注意：官方已不支持 `?api_key=` 查询参数形式（会返回 401 Authentication Fails），
  // 必须用请求头鉴权。
  let official = { ok: false, reason: 'no-key', at: 0, data: null, err: '' };
  async function fetchOfficial() {
    if (!config.apiKey) return;
    try {
      const res = await fetch('https://api.deepseek.com/user/balance', {
        headers: { authorization: 'Bearer ' + config.apiKey },
        signal: AbortSignal.timeout(15000)
      });
      if (res.status !== 200) {
        official = { ok: false, reason: 'http-' + res.status, at: Date.now(), data: null, err: '' };
        return;
      }
      const j = await res.json();
      const info = (j.balance_infos || [])[0] || {};
      official = {
        ok: true,
        reason: 'ok',
        at: Date.now(),
        err: '',
        data: {
          isAvailable: !!j.is_available,
          currency: info.currency || 'CNY',
          total: Number(info.total_balance) || 0,
          granted: Number(info.granted_balance) || 0,
          toppedUp: Number(info.topped_up_balance) || 0
        }
      };
      // 总预算跟随官网真实余额：预算 = 官网余额 + 本地累计已花，于是
      //   蓝条剩余 = budget − spent = 官网余额 −（自本次同步以来的本地花费）
      // 即"剩余金额"始终贴着账户真实余额，且两次同步之间仍会随消费递减。
      if (config.followOfficial) {
        const base = Math.round((official.data.total + totals.spent) * 100) / 100;
        if (Math.abs(base - config.budget) > 0.005) {
          config.budget = base;
          persistState();
        }
      }
    } catch (e) {
      official = { ok: false, reason: 'net', at: Date.now(), data: null, err: (e && (e.code || e.name)) || 'unknown' };
    }
  }
  if (timerSvc) {
    timerSvc.interval(() => fetchOfficial(), 60000); // 每 60 秒轮询一次官方余额
  }

  // ---------- agent 追踪 ----------
  const known = new Map();
  let tickSeq = 0;
  let activeSessionId = null;
  const isTop = (a) => !(a.options && a.options.subagentDepth);
  const touch = (agent) => { known.set(agent.id, { agent, t: ++tickSeq }); };
  let lastRootsCount = 0;
  // dsh 0.2.x 提供了 agents.roots()（顶层 agent 注册表视图），比靠 options 字段判断
  // 更可靠；每次快照都刷新一遍，避免事件时序（如 agent/session-start 在新版已不存在）
  // 导致活跃会话追踪不到、红条恒为 0。
  function refreshAgents() {
    try {
      const roots = typeof agentsSvc.roots === 'function' ? agentsSvc.roots() : agentsSvc.list().filter(isTop);
      lastRootsCount = roots.length;
      for (const a of roots) {
        known.set(a.id, { agent: a, t: ++tickSeq });
        if (activeSessionId === null) activeSessionId = a.id;
      }
      if (activeSessionId !== null && !known.has(activeSessionId)) {
        let best = null;
        for (const [id, entry] of known) if (!best || entry.t > best.t) best = { id, t: entry.t };
        activeSessionId = best ? best.id : null;
      }
    } catch (e) {
      lastRootsCount = -1;
    }
  }
  refreshAgents();

  // ---------- 度量缓存（measure 是 O(surface)，按日志版本缓存） ----------
  const measureCache = new Map();
  let lastMeasureErr = null;
  function measureOf(agent) {
    try {
      // dsh 0.2.x 的 Session 没有 events 数组，日志版本用 session.seq（SessionLogOffset）。
      const rev = agent.session && agent.session.seq !== undefined ? agent.session.seq : 0;
      const hit = measureCache.get(agent.id);
      if (hit && hit.rev === rev) return hit.m;
      const m = tokenMeter.measure(agent.session);
      measureCache.set(agent.id, { rev, m });
      lastMeasureErr = null;
      return m;
    } catch (e) {
      lastMeasureErr = String((e && e.message) || e).slice(0, 200);
      return null;
    }
  }
  const windowCache = new Map();
  function effectiveWindow(agent) {
    const cached = windowCache.get(agent.id);
    if (cached !== undefined) return cached;
    // 0.2.x 首选：session.requestContext() 直接给出 provider/model/contextWindow
    let rc = null;
    try {
      const s = agent.session;
      if (s && typeof s.requestContext === 'function') rc = s.requestContext() || null;
    } catch (e) { rc = null; }
    if (rc && Number(rc.contextWindow) > 0) {
      windowCache.set(agent.id, Number(rc.contextWindow));
      return Number(rc.contextWindow);
    }
    windowCache.set(agent.id, config.contextWindow); // 先用默认值，后台解析真实窗口
    const llm = ctx.get('llm');
    const opts = rc || agent.options || {};
    if (llm && opts.provider && opts.model) {
      llm.resolveModelInfo(opts.provider, opts.model).then((info) => {
        if (info && info.context && info.context.contextWindow > 0) windowCache.set(agent.id, info.context.contextWindow);
      }).catch(() => {});
    }
    return config.contextWindow;
  }

  // ---------- 费用 ----------
  // 费用在每次调用时按当时时段累加进 spent，这里直接取累计值。
  function spentOf(u) {
    return (u && typeof u.spent === 'number' && u.spent) || 0;
  }
  function recordUsage(sessionId, u) {
    if (!sessionId || !u) return;
    const at = Date.now();
    const cost = costOf(u, at); // 按本次调用发生时刻的时段计价
    const prev = usageBySession.get(sessionId) || zero();
    prev.input += u.inputTokens || 0;
    prev.output += u.outputTokens || 0;
    prev.cacheRead += u.cacheReadTokens || 0;
    prev.cacheWrite += u.cacheWriteTokens || 0;
    prev.calls += 1;
    prev.spent += cost;
    usageBySession.set(sessionId, prev);
    totals.input += u.inputTokens || 0;
    totals.output += u.outputTokens || 0;
    totals.cacheRead += u.cacheReadTokens || 0;
    totals.cacheWrite += u.cacheWriteTokens || 0;
    totals.calls += 1;
    totals.spent += cost;
    if (persistDebounced) persistDebounced();
  }

  // ---------- 每次模型调用记录真实 usage ----------
  ctx.on('llm/stream', (options, next) => {
    const inner = next();
    const sessionId = options.sessionId;
    return (async function* () {
      let usage = null;
      try {
        for await (const chunk of inner) {
          if (chunk && chunk.type === 'usage' && chunk.usage) usage = chunk.usage;
          yield chunk;
        }
      } finally {
        if (usage) recordUsage(sessionId, usage);
      }
    })();
  });

  // ---------- 活跃会话追踪 ----------
  ctx.on('agent/created', ({ agent }) => {
    if (!agent) return;
    touch(agent);
    if (isTop(agent)) activeSessionId = agent.id;
  });
  ctx.on('agent/status', ({ agent, status }) => {
    if (!agent) return;
    touch(agent);
    if (status === 'running' && isTop(agent)) activeSessionId = agent.id;
  });
  ctx.on('agent/disposed', ({ agent }) => {
    if (!agent) return;
    known.delete(agent.id);
    measureCache.delete(agent.id);
    windowCache.delete(agent.id);
    if (agent.id === activeSessionId) {
      let best = null;
      for (const [id, entry] of known) {
        const a = entry.agent;
        if (!isTop(a)) continue;
        if (!best || entry.t > best.t) best = { id, t: entry.t };
      }
      activeSessionId = best ? best.id : null;
    }
  });
  for (const a of agentsSvc.list()) {
    touch(a);
    if (isTop(a) && activeSessionId === null) activeSessionId = a.id;
  }

  // ---------- 档位 ----------
  function contextLevel(pct) {
    if (pct >= 0.9) return 'red';
    if (pct >= 0.8) return 'orange';
    if (pct >= config.compactThreshold) return 'yellow';
    return 'green';
  }
  function balanceLevel(pct) {
    if (pct <= 0.1) return 'red';
    if (pct <= 0.2) return 'orange';
    if (pct <= 0.5) return 'yellow';
    return 'green';
  }

  // ---------- 压缩区间选择（复刻引擎的平衡配对逻辑） ----------
  function selectCompactableRange(session, measurement, retainTokens) {
    const pricedNodes = measurement.nodes;
    if (!pricedNodes || pricedNodes.length === 0) return null;
    const surfaceNodes = session.surface.nodes;
    if (!surfaceNodes || surfaceNodes.length !== pricedNodes.length) return null;
    // dsh 0.2.x 的 Session 无 events 数组，按 seq 取事件用 eventAt()（旧版为 events[seq]）。
    const eventAt = (seq) => {
      if (typeof session.eventAt === 'function') return session.eventAt(seq);
      return session.events ? session.events[seq] : undefined;
    };
    const balancedBefore = new Array(surfaceNodes.length);
    let inProgress = 0;
    for (let i = 0; i < surfaceNodes.length; i++) {
      balancedBefore[i] = inProgress === 0;
      const seq = surfaceNodes[i];
      const event = eventAt(seq);
      if (!event || event.seq !== seq) return null;
      if (event.type === 'assistant/message') {
        const content = event.data && event.data.message && event.data.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && block.type === 'tool-call') inProgress += 1;
          }
        }
      } else if (event.type === 'tool/result') {
        inProgress -= 1;
      }
      if (inProgress < 0) return null;
    }
    let accumulated = 0;
    let keepFromIdx = surfaceNodes.length;
    for (let i = surfaceNodes.length - 1; i >= 0; i -= 1) {
      accumulated += pricedNodes[i].tokens;
      keepFromIdx = i;
      if (accumulated >= retainTokens) break;
    }
    if (keepFromIdx === 0) return null;
    while (keepFromIdx > 0) {
      if (balancedBefore[keepFromIdx]) break;
      keepFromIdx -= 1;
    }
    if (keepFromIdx === 0) return null;
    return { start: surfaceNodes[0], end: surfaceNodes[keepFromIdx - 1] };
  }

  // ---------- 游戏压缩：pre-step 时根据红条自动压缩 ----------
  ctx.on('agent/pre-step', async (payload, next) => {
    const agent = payload && payload.agent;
    const session = agent && agent.session;
    const signal = payload && payload.signal;
    const genBefore = session ? session.surface.replaceGeneration : null;
    let decision;
    try {
      decision = await next();
    } catch (e) {
      throw e;
    }
    if (!agent || !session || !signal) return decision;
    if (session.surface.replaceGeneration !== genBefore) return decision; // 内置压缩已处理，避免双重压缩
    try {
      const m = tokenMeter.measure(session);
      const window = effectiveWindow(agent);
      const pct = window > 0 ? m.totalTokens / window : 0;
      const shouldCompact = config.forceCompact || pct >= config.compactThreshold;
      if (!shouldCompact) return decision;
      const comp = presets ? presets.serviceFor(agent, 'compaction') : undefined;
      if (!comp) return decision;
      const range = selectCompactableRange(session, m, Math.floor(window * 0.16));
      if (!range) return decision;
      const before = m.surfaceTokens;
      // CompactionAgentContext = { session, options: { provider?, model? } }；
      // 0.2.x 首选 session.requestContext() 里的路由信息。
      let routed = null;
      try { routed = typeof session.requestContext === 'function' ? session.requestContext() : null; } catch (e) { routed = null; }
      const orig = agent.options || {};
      const compOptions = {
        provider: (routed && routed.provider) || orig.provider,
        model: (routed && routed.model) || orig.model
      };
      await comp.compactRegion(range.start, range.end, { session, options: compOptions }, signal);
      const after = tokenMeter.measure(session).surfaceTokens;
      compactStats.count += 1;
      compactStats.lastAt = Date.now();
      compactStats.savedTokens += Math.max(0, before - after);
      console.log('[game-mode] 自动压缩 ' + agent.id + ': ' + before + ' -> ' + after + ' tokens, 节省 ' + Math.max(0, before - after));
    } catch (e) {
      console.error('[game-mode] 压缩失败:', e && e.message || String(e));
    } finally {
      config.forceCompact = false;
    }
    return decision;
  });

  // ---------- HUD RPC ----------
  function buildWarning(ctxLevel, balLevel, ctxPct, balPct) {
    if (balLevel === 'red') return '余额即将耗尽（' + Math.round(balPct * 100) + '%），请立即充值！';
    if (ctxLevel === 'red') return '上下文临界（' + Math.round(ctxPct * 100) + '%）——下一步将强制压缩';
    if (balLevel === 'orange') return '余额告急（' + Math.round(balPct * 100) + '%）——请尽快充值';
    if (ctxLevel === 'orange') return '上下文高压（' + Math.round(ctxPct * 100) + '%）——即将自动压缩';
    if (balLevel === 'yellow') return '余额预警（' + Math.round(balPct * 100) + '%）';
    return null;
  }
  function snapshot() {
    refreshAgents(); // 每次快照都从 registry 刷新，保证活跃会话可见
    const entry = activeSessionId ? known.get(activeSessionId) : undefined;
    const agent = entry ? entry.agent : undefined;
    let context = { active: false, tokens: 0, surfaceTokens: 0, window: config.contextWindow, pct: 0, level: 'green' };
    let measured = false;
    if (agent) {
      const m = measureOf(agent);
      if (m) {
        measured = true;
        const window = effectiveWindow(agent);
        const pct = window > 0 ? m.totalTokens / window : 0;
        context = { active: true, tokens: m.totalTokens, surfaceTokens: m.surfaceTokens, window, pct, level: contextLevel(pct) };
      }
    }
    const sessionTokens = (agent && usageBySession.get(agent.id)) || zero();
    const sessionSpent = spentOf(sessionTokens);
    const totalSpent = spentOf(totals);
    const remaining = Math.max(0, config.budget - totalSpent);
    const bpct = config.budget > 0 ? remaining / config.budget : 1;
    const balLevel = balanceLevel(bpct);
    return {
      activeSessionId,
      context,
      balance: {
        budget: config.budget,
        spent: totalSpent,
        remaining,
        pct: bpct,
        level: balLevel,
        session: { id: agent ? agent.id : null, tokens: { ...sessionTokens }, spent: sessionSpent },
        total: { tokens: { ...totals }, spent: totalSpent }
      },
      official: { ok: official.ok, reason: official.reason, at: official.at, data: official.data, err: official.err },
      apiKeySet: !!config.apiKey,
      compact: { count: compactStats.count, lastAt: compactStats.lastAt, savedTokens: compactStats.savedTokens, armed: !!config.forceCompact },
      warning: buildWarning(context.level, balLevel, context.pct, bpct),
      // period：当前所处时段（off=空闲 / peak=高峰），HUD 显示用；计价由每次调用时刻决定。
      period: isOffPeak() ? 'off' : 'peak',
      debug: { known: known.size, roots: lastRootsCount, tracked: !!agent, measured, measureErr: lastMeasureErr },
      config: {
        budget: config.budget,
        priceInputOff: config.priceInputOff,
        priceInputPeak: config.priceInputPeak,
        priceCacheOff: config.priceCacheOff,
        priceCachePeak: config.priceCachePeak,
        priceOutputOff: config.priceOutputOff,
        priceOutputPeak: config.priceOutputPeak,
        contextWindow: config.contextWindow,
        compactThreshold: config.compactThreshold,
        followOfficial: !!config.followOfficial,
        apiKeySet: !!config.apiKey
      }
    };
  }

  // ---------- HUD 窗口状态持久化（磁盘，升级/重启不丢） ----------
  let hudState = null; // { pos: {left, top} | null, size: {width, height} | null }
  function sanitizeHud(a) {
    const clean = {};
    if (a.pos && typeof a.pos === 'object') {
      const left = Number(a.pos.left);
      const top = Number(a.pos.top);
      if (Number.isFinite(left) && Number.isFinite(top)) clean.pos = { left: Math.round(left), top: Math.round(top) };
    }
    if (a.size && typeof a.size === 'object') {
      const w = Number(a.size.width);
      const h = Number(a.size.height);
      if (Number.isFinite(w) && Number.isFinite(h)) clean.size = { width: Math.max(120, Math.round(w)), height: Math.max(28, Math.round(h)) };
    }
    if (typeof a.collapsed === 'boolean') clean.collapsed = a.collapsed; // 收起为小条，点击可再展开
    return clean;
  }
  function persistState() {
    const bySession = {};
    for (const [id, v] of usageBySession) bySession[id] = { ...v };
    return saveStateFile({
      config: { ...config },
      hud: hudState,
      usage: { totals: { ...totals }, bySession, compact: { ...compactStats } }
    });
  }
  // 启动时从磁盘恢复用户设置、窗口状态与用量累计（不覆盖用户已改的值）
  loadStateFile().then((st) => {
    if (!st || typeof st !== 'object') return;
    if (st.config && typeof st.config === 'object') {
      const a = st.config;
      // 旧版三档价格（priceInput/priceCacheRead/priceOutput）属于历史格式，不再继承：
      // 它们与官方新的空闲/高峰双档不是同一口径，继承会把旧值（如缓存命中 0.5）误当作高峰价。
      const next = {
        budget: num(a.budget, 0, 1e9) ?? config.budget,
        priceInputOff: num(a.priceInputOff, 0, 1e6) ?? config.priceInputOff,
        priceInputPeak: num(a.priceInputPeak, 0, 1e6) ?? config.priceInputPeak,
        priceCacheOff: num(a.priceCacheOff, 0, 1e6) ?? config.priceCacheOff,
        priceCachePeak: num(a.priceCachePeak, 0, 1e6) ?? config.priceCachePeak,
        priceOutputOff: num(a.priceOutputOff, 0, 1e6) ?? config.priceOutputOff,
        priceOutputPeak: num(a.priceOutputPeak, 0, 1e6) ?? config.priceOutputPeak,
        contextWindow: num(a.contextWindow, 1024, 10000000) ?? config.contextWindow,
        compactThreshold: num(a.compactThreshold, 0.1, 0.95) ?? config.compactThreshold
      };
      Object.assign(config, next);
      if (typeof a.followOfficial === 'boolean') config.followOfficial = a.followOfficial;
      if (typeof a.apiKey === 'string' && a.apiKey) config.apiKey = a.apiKey;
    }
    if (st.hud && typeof st.hud === 'object') hudState = sanitizeHud(st.hud);
    if (st.usage && typeof st.usage === 'object') {
      const u = st.usage;
      if (u.totals && typeof u.totals === 'object') {
        for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'calls']) {
          if (typeof u.totals[k] === 'number') totals[k] = u.totals[k];
        }
        // 旧状态没有 spent：按高峰档回估算一次，避免历史费用显示为 0。
        totals.spent = typeof u.totals.spent === 'number'
          ? u.totals.spent
          : costOf({ input: totals.input, output: totals.output, cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite }, PEAK_SAMPLE_AT);
      }
      if (u.bySession && typeof u.bySession === 'object') {
        for (const [id, val] of Object.entries(u.bySession)) {
          const rec = {
            input: val.input || 0,
            output: val.output || 0,
            cacheRead: val.cacheRead || 0,
            cacheWrite: val.cacheWrite || 0,
            calls: val.calls || 0,
            spent: 0
          };
          rec.spent = typeof val.spent === 'number'
            ? val.spent
            : costOf({ input: rec.input, output: rec.output, cacheRead: rec.cacheRead, cacheWrite: rec.cacheWrite }, PEAK_SAMPLE_AT);
          usageBySession.set(id, rec);
        }
      }
      if (u.compact && typeof u.compact === 'object') {
        compactStats.count = u.compact.count || 0;
        compactStats.savedTokens = u.compact.savedTokens || 0;
        compactStats.lastAt = u.compact.lastAt || 0;
      }
    }
    if (config.apiKey) fetchOfficial().catch(() => {}); // 恢复后立即拉一次官方余额
  }).catch((e) => {
    console.error('[game-mode] 恢复状态失败:', e && e.message || String(e));
  });

  // ---------- 业务分派（Client 半 POST /game-mode/<method> 调用） ----------
  // 返回值统一为 RpcResult 形状：成功 { ok: true, value }，失败 { ok: false, error }，
  // 浏览器端只做形状检查（不再依赖 connection 的 zod schema 校验）。
  async function dispatch(endpoint, payload) {
    switch (endpoint) {
      case 'state': {
        // 官方余额超过 30 秒未更新且已配置 key 时，顺带异步刷新（HUD 每 1.5s 轮询 state）
        if (config.apiKey && Date.now() - official.at > 30000) fetchOfficial().catch(() => {});
        return { ok: true, value: snapshot() };
      }
      case 'get-hud-state':
        return { ok: true, value: hudState || {} };
      case 'set-hud-state': {
        hudState = sanitizeHud(payload || {});
        persistState();
        return { ok: true, value: hudState };
      }
      case 'set-config': {
        const a = payload || {};
        const next = {
          budget: num(a.budget, 0, 1e9) ?? config.budget,
          priceInputOff: num(a.priceInputOff, 0, 1e6) ?? config.priceInputOff,
          priceInputPeak: num(a.priceInputPeak, 0, 1e6) ?? config.priceInputPeak,
          priceCacheOff: num(a.priceCacheOff, 0, 1e6) ?? config.priceCacheOff,
          priceCachePeak: num(a.priceCachePeak, 0, 1e6) ?? config.priceCachePeak,
          priceOutputOff: num(a.priceOutputOff, 0, 1e6) ?? config.priceOutputOff,
          priceOutputPeak: num(a.priceOutputPeak, 0, 1e6) ?? config.priceOutputPeak,
          contextWindow: num(a.contextWindow, 1024, 10000000) ?? config.contextWindow,
          compactThreshold: num(a.compactThreshold, 0.1, 0.95) ?? config.compactThreshold
        };
        Object.assign(config, next);
        // followOfficial 是布尔开关（默认跟随官网余额）；显式传入时才改变。
        if (typeof a.followOfficial === 'boolean') config.followOfficial = a.followOfficial;
        if (typeof a.apiKey === 'string' && a.apiKey.length > 0) config.apiKey = a.apiKey;
        persistState();
        fetchOfficial().catch(() => {}); // 保存后立即验证并刷新官方余额（跟随模式下同时同步预算）
        return { ok: true, value: snapshot() };
      }
      case 'arm-compact':
        config.forceCompact = true;
        return { ok: true, value: { armed: true } };
      case 'reset':
        usageBySession.clear();
        for (const k of Object.keys(totals)) totals[k] = 0;
        compactStats.count = 0;
        compactStats.savedTokens = 0;
        compactStats.lastAt = 0;
        persistState();
        return { ok: true, value: snapshot() };
      default:
        return { ok: false, error: { code: 'internal', message: 'unknown endpoint: ' + endpoint, details: {} } };
    }
  }

  // ---------- HTTP 路由注册 ----------
  // dsh 0.2.x 中 connection.rpc.handle 已不可用（其内部 owner 固定为 connection 插件自身的
  // ctx，永远拿不到 webServer，会抛 "cannot get property webServer without inject"；官方代码
  // 中该 API 的调用点为 0）。因此与官方 client-modules 一致，直接在 webServer 上注册前缀
  // 路由；同源页面内的 fetch 能正常到达 webServer 分派（此前请求落到静态 fallback 的 405
  // 已证明这一点）。
  // 协议（自定义，简单）：POST /game-mode/<method>，请求体即 payload JSON，
  // 响应体 { ok: true, value } | { ok: false, error: { message } }。
  function readBody(req, limit = 1 << 20) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > limit) { reject(new Error('body too large')); try { req.destroy(); } catch (e) {} }
      });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  }
  const ROUTE_PREFIX = '/game-mode';
  const routeHandler = async (req, res) => {
    const fail = (status, message) => {
      try { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: { message } })); } catch (e) {}
    };
    if (req.method !== 'POST') return fail(405, 'method not allowed');
    let endpoint = '';
    try { endpoint = new URL(req.url, 'http://127.0.0.1').pathname.slice(ROUTE_PREFIX.length + 1); } catch (e) {}
    if (!endpoint || endpoint.indexOf('/') >= 0) return fail(404, 'unknown endpoint');
    let payload = {};
    try {
      const raw = await readBody(req);
      payload = raw ? JSON.parse(raw) : {};
    } catch (e) {
      return fail(400, 'invalid body: ' + (e && e.message));
    }
    try {
      const result = await dispatch(endpoint, payload);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('[game-mode] RPC 处理失败', endpoint, e && e.message);
      fail(500, String((e && e.message) || e));
    }
  };

  ctx.inject(['webServer'], (webCtx) => {
    try {
      const disposer = webCtx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: routeHandler });
      writeBoot({ channel: 'ok', route: ROUTE_PREFIX, routeDisposer: typeof disposer });
    } catch (e) {
      boot.channel = 'ERR ' + (e && e.message ? e.message : String(e));
      boot.channelStack = e && e.stack ? String(e.stack).slice(0, 600) : null;
      writeBoot({});
      console.error('[game-mode] 注册 /game-mode 路由失败:', e && e.message);
    }
  });
}
