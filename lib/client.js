/**
 * AI-Hud（原游戏模式 HUD）— Client 半（部署级插件 bundle，随 dsh 启动自动挂载）。
 *
 * 与动态插件版的差异：
 *  - 通信：直接 POST /game-mode/<method>（同源 fetch），Host 半在 webServer 上注册前缀路由
 *  - 定时：浏览器 setInterval + ctx.effect 清理（无 ctx.timer）
 *  - 样式：手动 <style> 注入 document.head
 *  - React：require("react") 种子词（bundle 内禁用 import/JSX 语法）
 */
window.__ModuleLoader__.load({
  id: "ai-hud",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react = require("react");
    const h = react.createElement;
    const { useState, useEffect, useRef } = react;

    // ---------- 常量与格式化（与动态插件版一致） ----------
    const CTX_TEXT = { green: '正常', yellow: '关注', orange: '高压', red: '临界' };
    const BAL_TEXT = { green: '充足', yellow: '预警', orange: '告急', red: '耗尽' };
    const fmtInt = (n) => String(Math.round(n || 0)); // 纯数字，无千分位
    const fmtMoney = (n) => '¥' + (Math.round((n || 0) * 100) / 100).toFixed(2);
    const fmtTok = (n) => {
      n = n || 0;
      if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
      return String(Math.round(n));
    };
    const fmtPct = (n) => Math.round((n || 0) * 100) + '%';

    function Badge({ level, children }) {
      return h('span', { className: 'game-hud-badge ' + level }, children);
    }
    function Bar({ tone, pct, level }) {
      const fillPct = Math.min(100, Math.max(0, (pct || 0) * 100));
      // 轨道 + 填充双层结构：外层固定高度，内层按百分比填充（无轨道时 height:100% 解析为 0，进度条不可见）
      return h('div', { className: 'game-hud-bar' },
        h('div', { className: 'game-hud-fill ' + tone + (level === 'red' ? ' pulse' : ''), style: { width: fillPct + '%' } })
      );
    }

    function Settings({ cfg, onSave, onClose }) {
      const [draft, setDraft] = useState({
        budget: String(cfg.budget),
        priceInputOff: String(cfg.priceInputOff),
        priceInputPeak: String(cfg.priceInputPeak),
        priceCacheOff: String(cfg.priceCacheOff),
        priceCachePeak: String(cfg.priceCachePeak),
        priceOutputOff: String(cfg.priceOutputOff),
        priceOutputPeak: String(cfg.priceOutputPeak),
        contextWindow: String(cfg.contextWindow),
        compactThreshold: String(cfg.compactThreshold),
        followOfficial: cfg.followOfficial !== false, // 默认跟随官网真实余额
        apiKey: ''
      });
      const set = (k) => (ev) => setDraft((d) => ({ ...d, [k]: ev.target.value }));
      const save = () => {
        const out = {
          budget: Number(draft.budget),
          priceInputOff: Number(draft.priceInputOff),
          priceInputPeak: Number(draft.priceInputPeak),
          priceCacheOff: Number(draft.priceCacheOff),
          priceCachePeak: Number(draft.priceCachePeak),
          priceOutputOff: Number(draft.priceOutputOff),
          priceOutputPeak: Number(draft.priceOutputPeak),
          contextWindow: Number(draft.contextWindow),
          compactThreshold: Number(draft.compactThreshold),
          followOfficial: !!draft.followOfficial
        };
        if (draft.apiKey.trim()) out.apiKey = draft.apiKey.trim(); // 留空则保持原 key 不变
        onSave(out);
        onClose();
      };
      // 官方按空闲/高峰双档计价（元 / 1M tokens）；缓存写入按未命中输入价计。
      // 第三项是悬停说明（鼠标停在行上即可看到该参数的含义）。
      const fields = [
        ['总预算(元)', 'budget', '蓝条分母：剩余 = 预算 − 累计花费。开启下方"跟随官网"后由官网余额自动同步，无需手填'],
        ['未命中输入·空闲', 'priceInputOff', '元 / 1M tokens：缓存未命中的输入（缓存写入也按此价）'],
        ['未命中输入·高峰', 'priceInputPeak', '元 / 1M tokens：缓存未命中的输入（缓存写入也按此价）'],
        ['缓存命中·空闲', 'priceCacheOff', '元 / 1M tokens：命中缓存的输入读取'],
        ['缓存命中·高峰', 'priceCachePeak', '元 / 1M tokens：命中缓存的输入读取'],
        ['输出·空闲', 'priceOutputOff', '元 / 1M tokens：模型输出'],
        ['输出·高峰', 'priceOutputPeak', '元 / 1M tokens：模型输出'],
        ['上下文窗口(tokens)', 'contextWindow', '红条的分母（当前占用 ÷ 窗口）。HUD 会自动读取模型真实窗口，此项仅作为读不到时的备用值'],
        ['压缩阈值(比例)', 'compactThreshold', '红条达到该比例时自动压缩历史（0.65 = 65%）：把较老的内容总结成一条摘要并保留最近 16%'],
        ['API Key', 'apiKey', '用于读取官网真实余额（Authorization: Bearer），保存在本机状态文件中']
      ];
      const renderField = ([label, key, hint]) => h('div', { className: 'game-hud-field', key, title: hint || '' },
        h('span', null, label),
        h('input', {
          value: draft[key],
          onChange: set(key),
          type: key === 'apiKey' ? 'password' : 'text',
          disabled: key === 'budget' && draft.followOfficial, // 跟随时预算由官网同步，禁止手改
          placeholder: key === 'apiKey' ? (cfg.apiKeySet ? '已保存' : 'sk-') : ''
        })
      );
      const followRow = h('label', {
        className: 'game-hud-field game-hud-check',
        title: '开启后总预算自动同步为官网真实余额（需已填 API Key）：蓝条的"剩余金额"即账户真实余额，每 60 秒刷新'
      },
        h('span', null, '总预算跟随官网真实余额'),
        h('input', {
          type: 'checkbox',
          checked: !!draft.followOfficial,
          onChange: (ev) => setDraft((d) => ({ ...d, followOfficial: ev.target.checked }))
        })
      );
      return h('div', { className: 'game-hud-settings' },
        renderField(fields[0]),   // 总预算
        followRow,                // 跟随开关（紧贴预算）
        fields.slice(1).map(renderField),
        h('div', { className: 'game-hud-field game-hud-field-actions' },
          h('button', { onClick: save }, '保存'),
          h('button', { onClick: onClose }, '关闭')
        )
      );
    }

    function GameHud({ rpc }) {
      const [s, setS] = useState(null);
      const [err, setErr] = useState(null);
      const [cfgOpen, setCfgOpen] = useState(false);
      const [menuOpen, setMenuOpen] = useState(false);
      const [metaOpen, setMetaOpen] = useState(false); // 详细用量默认折叠
      const [pos, setPos] = useState(null); // null = 默认右下角；拖动后 {left, top}
      const [size, setSize] = useState(null); // null = 默认 320 x 内容自适应；缩放后 {width, height}
      const [dragging, setDragging] = useState(false);
      const [resizing, setResizing] = useState(false);
      const [collapsed, setCollapsed] = useState(false); // 收起为小药丸，点击展开
      const [light, setLight] = useState(() => detectLightTheme()); // 浅色皮肤自动跟随界面主题
      const dragRef = useRef(null);
      const resizeRef = useRef(null);
      const hudRef = useRef(null);
      const posRef = useRef(null);
      const sizeRef = useRef(null);
      const collapsedRef = useRef(false);
      const MIN_W = 120;
      const MIN_H = 28;
      const persist = () => {
        rpc('set-hud-state', { pos: posRef.current, size: sizeRef.current, collapsed: collapsedRef.current }).catch(() => {});
      };
      useEffect(() => {
        let dead = false;
        rpc('get-hud-state', {}).then((hs) => {
          if (dead) return;
          hs = hs || {};
          if (hs.pos) { posRef.current = hs.pos; setPos(hs.pos); }
          if (hs.size) { sizeRef.current = hs.size; setSize(hs.size); }
          if (typeof hs.collapsed === 'boolean') { collapsedRef.current = hs.collapsed; setCollapsed(hs.collapsed); }
        }).catch(() => {});
        const tick = async () => {
          const isLight = detectLightTheme();
          setLight((prev) => (prev === isLight ? prev : isLight));
          try {
            const st = await rpc('state', {});
            if (!dead) { setS(st); setErr(null); }
          } catch (e) {
            if (!dead) setErr('未连接: ' + String((e && e.message) || e).slice(0, 100));
          }
        };
        tick();
        const id = setInterval(tick, 1500);
        return () => { dead = true; clearInterval(id); };
      }, []);
      const setCollapsedPersist = (v) => {
        collapsedRef.current = v;
        setCollapsed(v);
        setMenuOpen(false);
        persist();
      };

      const onTitlePointerDown = (e) => {
        if (e.target && e.target.closest && e.target.closest('button')) return;
        const win = hudRef.current;
        if (!win) return;
        const rect = win.getBoundingClientRect();
        dragRef.current = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
        win.style.left = Math.round(rect.left) + 'px';
        win.style.top = Math.round(rect.top) + 'px';
        win.style.right = 'auto';
        win.style.bottom = 'auto';
        win.style.width = (size ? size.width : 320) + 'px';
        setPos({ left: Math.round(rect.left), top: Math.round(rect.top) });
        setDragging(true);
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
      };
      const onTitlePointerMove = (e) => {
        const d = dragRef.current;
        const win = hudRef.current;
        if (!d || !win) return;
        win.style.left = Math.round(d.left + (e.clientX - d.x)) + 'px';
        win.style.top = Math.round(d.top + (e.clientY - d.y)) + 'px';
      };
      const onTitlePointerUp = (e) => {
        const win = hudRef.current;
        if (win && dragRef.current) {
          const r = win.getBoundingClientRect();
          const next = { left: Math.round(r.left), top: Math.round(r.top) };
          posRef.current = next;
          setPos(next);
          persist();
        }
        dragRef.current = null;
        setDragging(false);
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) {}
      };

      const onResizePointerDown = (e) => {
        const win = hudRef.current;
        if (!win) return;
        const rect = win.getBoundingClientRect();
        resizeRef.current = { x: e.clientX, y: e.clientY, width: rect.width, height: rect.height };
        win.style.width = (size ? size.width : 320) + 'px';
        win.style.height = (size ? size.height : rect.height) + 'px';
        setResizing(true);
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
      };
      const onResizePointerMove = (e) => {
        const r = resizeRef.current;
        const win = hudRef.current;
        if (!r || !win) return;
        const w = Math.max(MIN_W, Math.round(r.width + (e.clientX - r.x)));
        const hh = Math.max(MIN_H, Math.round(r.height + (e.clientY - r.y)));
        win.style.width = w + 'px';
        win.style.height = hh + 'px';
      };
      const onResizePointerUp = (e) => {
        const win = hudRef.current;
        if (win && resizeRef.current) {
          const r = win.getBoundingClientRect();
          const next = { width: Math.round(r.width), height: Math.round(r.height) };
          sizeRef.current = next;
          setSize(next);
          persist();
        }
        resizeRef.current = null;
        setResizing(false);
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) {}
      };

      if (!s) return h('div', { className: 'game-hud' + (light ? ' hud-light' : ''), ref: hudRef }, err || '连接中…');
      const ctxv = s.context || {};
      const bal = s.balance || {};
      const comp = s.compact || {};
      const off = s.official || {};
      const cfgv = s.config || {};
      // 当前时段对应单价（Host 侧按每次调用发生时刻计价，这里仅展示当前档位）
      const priceNow = s.period === 'off'
        ? { input: cfgv.priceInputOff, cacheRead: cfgv.priceCacheOff, output: cfgv.priceOutputOff }
        : { input: cfgv.priceInputPeak, cacheRead: cfgv.priceCachePeak, output: cfgv.priceOutputPeak };
      const tok = (t) => 'in ' + fmtTok(t.input) + ' / out ' + fmtTok(t.output) + (t.cacheRead ? ' / cache ' + fmtTok(t.cacheRead) : '');
      // 官网余额行：区分 未配置 / 成功 / 鉴权失败 / 接口错误 / 网络不可用（含精确错误码便于诊断）
      let offLine;
      if (!s.apiKeySet) offLine = h('div', { className: 'game-hud-official' }, '官网未连接 · 设置中填 API Key');
      else if (off.ok && off.data) offLine = h('div', { className: 'game-hud-official' + (off.data.isAvailable ? '' : ' bad') },
        '官网 ' + fmtMoney(off.data.total) + ' · ' + (off.data.isAvailable ? '可用' : '余额不足'));
      else {
        const reason = off.reason || '';
        let text;
        if (reason === 'http-401' || reason === 'http-403') text = '官网鉴权失败(' + reason.slice(4) + ') · Key 无效';
        else if (reason.indexOf('http-') === 0) text = '官网接口错误(' + reason.slice(5) + ')';
        else if (reason === 'net') text = '官网失败(' + (off.err || 'unknown') + ')';
        else text = '官网获取失败';
        offLine = h('div', { className: 'game-hud-official bad' }, text);
      }
      const hudStyle = pos
        ? { left: pos.left, top: pos.top, right: 'auto', bottom: 'auto', width: size ? size.width : 320, height: size ? size.height : undefined }
        : { right: 12, bottom: 12, width: size ? size.width : 320, height: size ? size.height : undefined };
      const themeCls = light ? ' hud-light' : '';

      // 收起态：小药丸（显示红条状态点 + 真实余额），点击展开
      if (collapsed) {
        const pillStyle = pos ? { left: pos.left, top: pos.top, right: 'auto', bottom: 'auto' } : { right: 12, bottom: 12 };
        return h('div', {
          className: 'game-hud game-hud-collapsed' + themeCls,
          style: pillStyle,
          ref: hudRef,
          title: 'AI-Hud 已收起 · 点击展开',
          onClick: () => setCollapsedPersist(false)
        },
          h('span', { className: 'game-hud-pill' },
            h('span', { className: 'game-hud-dot ' + (ctxv.level || 'green') }),
            h('span', null, 'AI-Hud'),
            bal.budget || bal.remaining ? h('span', null, fmtMoney(bal.remaining)) : null
          )
        );
      }

      return h('div', { className: 'game-hud' + themeCls + (dragging ? ' dragging' : '') + (resizing ? ' resizing' : ''), style: hudStyle, ref: hudRef },
        h('div', { className: 'game-hud-title',
          onPointerDown: onTitlePointerDown,
          onPointerMove: onTitlePointerMove,
          onPointerUp: onTitlePointerUp,
          onPointerCancel: onTitlePointerUp },
          h('span', null, 'AI-Hud'),
          h('span', { className: 'game-hud-actions' },
            h('button', { className: 'game-hud-more', title: '更多操作', onClick: () => setMenuOpen((v) => !v) }, '⋯'),
            menuOpen ? h('div', { className: 'game-hud-menu' },
              h('button', { onClick: () => { setMenuOpen(false); rpc('arm-compact', {}).then(() => rpc('state', {}).then(setS)); } }, comp.armed ? '已武装' : '压缩'),
              h('button', { onClick: () => { setMenuOpen(false); setCfgOpen((v) => !v); } }, '设置'),
              h('button', { onClick: () => setCollapsedPersist(true) }, '收起'),
              h('button', { onClick: () => { setMenuOpen(false); rpc('reset', {}).then(setS); } }, '重置')
            ) : null
          )
        ),
        h('div', { className: 'game-hud-label' },
          h('span', null, '上下文 ' + fmtInt(ctxv.tokens) + ' / ' + fmtInt(ctxv.window)),
          h('span', null, fmtPct(ctxv.pct), ' ', h(Badge, { level: ctxv.level }, CTX_TEXT[ctxv.level] || ctxv.level))
        ),
        h(Bar, { tone: 'ctx', pct: ctxv.pct, level: ctxv.level }),
        h('div', { className: 'game-hud-label' },
          h('span', null, '余额 ' + fmtMoney(bal.remaining) + ' / ' + fmtMoney(bal.budget)),
          h('span', null, fmtPct(bal.pct), ' ', h(Badge, { level: bal.level }, BAL_TEXT[bal.level] || bal.level))
        ),
        h(Bar, { tone: 'bal', pct: bal.pct, level: bal.level }),
        offLine,
        h('div', { className: 'game-hud-meta-toggle', onClick: () => setMetaOpen((v) => !v) },
          h('span', null, metaOpen ? '▾' : '▸'), ' 详细用量'
        ),
        metaOpen ? h('div', { className: 'game-hud-meta' },
          h('div', null, '会话 ' + tok((bal.session || {}).tokens || {}) + ' · ' + fmtMoney(bal.session ? bal.session.spent : 0)),
          h('div', null, '总耗 ' + tok((bal.total || {}).tokens || {})),
          h('div', null, '金额 ' + fmtMoney(bal.total ? bal.total.spent : 0) + ' · 剩 ' + fmtMoney(bal.remaining)),
          h('div', null, '压缩 ' + comp.count + ' 次 · 省 ' + fmtTok(comp.savedTokens)),
          // 当前计价时段与对应单价（未命中输入 / 缓存命中 / 输出，元 per 1M）
          h('div', null, '时段 ' + (s.period === 'off' ? '空闲' : '高峰') + ' · 未命中 ' + fmtMoney(priceNow.input)
            + ' · 命中 ' + fmtMoney(priceNow.cacheRead) + ' · 输出 ' + fmtMoney(priceNow.output))
        ) : null,
        s.warning ? h('div', { className: 'game-hud-warn' }, s.warning) : null,
        cfgOpen && s.config ? h(Settings, { cfg: s.config, onSave: (c) => rpc('set-config', c).then(setS), onClose: () => setCfgOpen(false) }) : null,
        h('div', { className: 'game-hud-resize',
          onPointerDown: onResizePointerDown,
          onPointerMove: onResizePointerMove,
          onPointerUp: onResizePointerUp,
          onPointerCancel: onResizePointerUp })
      );
    }

    // ---------- 插件主体 ----------
    const inject = ['slots'];

    const HUD_STYLES = `
      /* 基础色直接取 dsh 主题变量（--dsw-alias-*），因此浅色/深色皮肤自动跟随界面；
         状态色给两套（默认深色主题用亮色前景，.hud-light 用加深后的前景）。 */
      .game-hud { position: fixed; z-index: 9999; width: 320px; box-sizing: border-box; pointer-events: auto; overflow-y: auto;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
        font-weight: 700; font-variant-numeric: tabular-nums;
        font-size: 11px; line-height: 1.45;
        --hud-bg: var(--dsw-alias-bg-overlay, rgba(17, 20, 27, 0.97));
        --hud-fg: var(--dsw-alias-label-primary, #e5e7eb);
        --hud-fg2: var(--dsw-alias-label-secondary, #94a3b8);
        --hud-border: var(--dsw-alias-border-l1, rgba(148, 163, 184, 0.25));
        --hud-hover: rgba(148, 163, 184, 0.16);
        --hud-track: rgba(148, 163, 184, 0.14);
        --hud-input-bg: rgba(15, 23, 42, 0.55);
        --hud-green: #4ade80;  --hud-green-bg: rgba(34, 197, 94, 0.18);
        --hud-yellow: #facc15; --hud-yellow-bg: rgba(234, 179, 8, 0.18);
        --hud-orange: #fb923c; --hud-orange-bg: rgba(249, 115, 22, 0.2);
        --hud-red: #f87171;    --hud-red-bg: rgba(239, 68, 68, 0.22);
        --hud-blue: #38bdf8;   --hud-blue2: #2563eb;
        --hud-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
        color: var(--hud-fg); background: var(--hud-bg); border: 1px solid var(--hud-border);
        border-radius: 8px; padding: 8px 10px;
        box-shadow: var(--hud-shadow); user-select: none; }
      /* 浅色皮肤：状态色加深，保证在白底上仍然可读 */
      .game-hud.hud-light {
        --hud-fg2: var(--dsw-alias-label-secondary, #64748b);
        --hud-hover: rgba(100, 116, 139, 0.14);
        --hud-track: rgba(100, 116, 139, 0.2);
        --hud-input-bg: rgba(241, 245, 249, 0.9);
        --hud-green: #15803d;  --hud-green-bg: rgba(34, 197, 94, 0.14);
        --hud-yellow: #a16207; --hud-yellow-bg: rgba(234, 179, 8, 0.16);
        --hud-orange: #c2410c; --hud-orange-bg: rgba(249, 115, 22, 0.14);
        --hud-red: #b91c1c;    --hud-red-bg: rgba(239, 68, 68, 0.14);
        --hud-blue: #0369a1;   --hud-blue2: #1d4ed8;
        --hud-shadow: 0 2px 8px rgba(15, 23, 42, 0.07); }
      .game-hud .game-hud-title { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--hud-fg);
        cursor: move; touch-action: none; margin-bottom: 2px; }
      .game-hud.dragging, .game-hud.resizing { opacity: 0.92; }
      .game-hud .game-hud-actions { display: flex; gap: 2px; cursor: default; position: relative; }
      .game-hud button { background: transparent; color: var(--hud-fg2); border: none; border-radius: 4px; font-size: 11px; font-weight: 700; font-family: inherit; padding: 1px 6px; cursor: pointer; }
      .game-hud button:hover { background: var(--hud-hover); color: var(--hud-fg); }
      .game-hud .game-hud-more { font-size: 15px; line-height: 1; padding: 0 6px; }
      .game-hud .game-hud-menu { position: absolute; right: 0; top: 24px; z-index: 20; min-width: 96px;
        background: var(--hud-bg); border: 1px solid var(--hud-border); border-radius: 6px; padding: 3px;
        box-shadow: var(--hud-shadow); display: flex; flex-direction: column; }
      .game-hud .game-hud-menu button { text-align: left; padding: 4px 10px; border-radius: 4px; }
      .game-hud .game-hud-label { display: flex; justify-content: space-between; align-items: center; margin: 4px 0 2px; }
      .game-hud .game-hud-bar { height: 8px; border-radius: 4px; background: var(--hud-track); overflow: hidden; }
      .game-hud .game-hud-fill { height: 100%; border-radius: 4px; transition: width 0.4s ease; }
      .game-hud .game-hud-fill.ctx { background: linear-gradient(90deg, var(--hud-red), var(--hud-orange)); }
      .game-hud .game-hud-fill.bal { background: linear-gradient(90deg, var(--hud-blue2), var(--hud-blue)); }
      .game-hud .game-hud-fill.pulse { animation: game-hud-pulse 1s infinite; }
      .game-hud .game-hud-badge { padding: 0 5px; border-radius: 4px; font-size: 10px; }
      .game-hud .game-hud-badge.green { background: var(--hud-green-bg); color: var(--hud-green); }
      .game-hud .game-hud-badge.yellow { background: var(--hud-yellow-bg); color: var(--hud-yellow); }
      .game-hud .game-hud-badge.orange { background: var(--hud-orange-bg); color: var(--hud-orange); }
      .game-hud .game-hud-badge.red { background: var(--hud-red-bg); color: var(--hud-red); animation: game-hud-pulse 1s infinite; }
      .game-hud .game-hud-meta-toggle { color: var(--hud-fg2); margin-top: 4px; cursor: pointer; font-weight: 400; font-size: 10px; }
      .game-hud .game-hud-meta-toggle:hover { color: var(--hud-fg); }
      .game-hud .game-hud-meta { color: var(--hud-fg2); margin-top: 3px; font-weight: 400; font-size: 10px; }
      .game-hud .game-hud-official { color: var(--hud-fg2); margin-top: 3px; font-weight: 400; font-size: 10px; }
      .game-hud .game-hud-official.bad { color: var(--hud-red); }
      .game-hud .game-hud-warn { color: var(--hud-red); margin-top: 4px; animation: game-hud-pulse 0.8s infinite; }
      .game-hud .game-hud-settings { margin-top: 6px; border-top: 1px dashed var(--hud-border); padding-top: 5px; }
      .game-hud .game-hud-field { display: flex; justify-content: space-between; align-items: center; margin: 3px 0; }
      .game-hud .game-hud-field-actions { justify-content: flex-end; gap: 6px; }
      .game-hud input { width: 96px; background: var(--hud-input-bg); border: 1px solid var(--hud-border); color: var(--hud-fg); border-radius: 4px; padding: 2px 6px; font-size: 11px; font-family: inherit; font-weight: 700; }
      .game-hud input[type="checkbox"] { width: auto; padding: 0; accent-color: var(--hud-blue2); cursor: pointer; }
      .game-hud input:disabled { opacity: 0.45; cursor: not-allowed; }
      .game-hud .game-hud-check { cursor: pointer; }
      .game-hud .game-hud-resize { position: absolute; right: 2px; bottom: 2px; width: 16px; height: 16px; cursor: nwse-resize; touch-action: none; }
      /* 右下角手柄不画图标：保留缩放热区与 nwse-resize 光标即可 */
      /* 收起态：一个小药丸，点击展开 */
      .game-hud.game-hud-collapsed { width: auto; min-width: 0; padding: 3px 9px; cursor: pointer; border-radius: 999px; overflow: visible; }
      .game-hud.game-hud-collapsed .game-hud-pill { display: flex; align-items: center; gap: 6px; font-size: 11px; }
      .game-hud .game-hud-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
      .game-hud .game-hud-dot.green { background: var(--hud-green); }
      .game-hud .game-hud-dot.yellow { background: var(--hud-yellow); }
      .game-hud .game-hud-dot.orange { background: var(--hud-orange); }
      .game-hud .game-hud-dot.red { background: var(--hud-red); }
      @keyframes game-hud-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
    `;

    // 判断当前界面是否为浅色主题：优先读 dsh 主题变量的实际色值亮度，
    // 失败时退回 DOM 上的主题标记，再退回系统偏好。
    function detectLightTheme() {
      try {
        const raw = getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-bg-base').trim();
        const m = raw.match(/rgba?\(([^)]+)\)/i);
        let r, g, b;
        if (m) {
          const p = m[1].split(',').map((s) => parseFloat(s));
          r = p[0]; g = p[1]; b = p[2];
        } else if (/^#[0-9a-f]{6}$/i.test(raw)) {
          const h = raw.slice(1);
          r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
        }
        if (typeof r === 'number' && !Number.isNaN(r)) return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
      } catch (e) { /* 继续走兜底判断 */ }
      try {
        const marks = [
          document.documentElement.getAttribute('data-theme'),
          document.documentElement.getAttribute('data-color-scheme'),
          document.documentElement.className,
          document.body && document.body.className
        ].filter(Boolean).join(' ').toLowerCase();
        if (/(^|[\s-])light([\s-]|$)/.test(marks)) return true;
        if (/(^|[\s-])dark([\s-]|$)/.test(marks)) return false;
        if (window.matchMedia) return window.matchMedia('(prefers-color-scheme: light)').matches;
      } catch (e) { /* 默认深色 */ }
      return false;
    }

    function apply(ctx) {
      const slots = ctx.get('slots');
      if (!slots) return;

      // 全局样式（apply 在浏览器执行，document 可用；随插件生命周期清理）
      const styleEl = document.createElement('style');
      styleEl.setAttribute('data-game-hud', '1');
      styleEl.textContent = HUD_STYLES;
      document.head.appendChild(styleEl);
      ctx.effect(() => {
        return () => {
          if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
        };
      });

      // Host 通信：直接 POST /game-mode/<method>（同源）。
      // 不用 connection.rpc.call：dsh 0.2.x 的 connection RPC 门面已不可用于第三方插件，
      // Host 半改为在 webServer 上直接注册 /game-mode 前缀路由。
      // 响应体 { ok: true, value } | { ok: false, error: { message } }。
      const rpc = async (method, payload) => {
        const res = await fetch('/game-mode/' + method, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload || {})
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json();
        if (!j || j.ok !== true) {
          const err = (j && j.error) || {};
          throw new Error(err.message || 'RPC 失败: ' + method);
        }
        return j.value;
      };

      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'game-hud', order: 100, label: 'AI-Hud' },
        () => h(GameHud, { rpc })
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
