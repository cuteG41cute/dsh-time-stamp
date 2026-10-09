// dsh-time-stamp — Client half (static / composition plugin)
//
// Browser bundle consumed by the client module loader (window.__ModuleLoader__).
// Talks to the Host through the plugin's own JSON API on the webServer route
// (POST /dsh-time-stamp/api) via fetch — no settingsScope (the apiProxy
// settings allowlist does not expose third-party namespaces), no typert/zod.
window.__ModuleLoader__.load({
  id: 'dsh-time-stamp',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    let react = require('react');

    // ── plugin-owned JSON RPC over the host webServer route ──
    function rpc(method, args) {
      return fetch('/dsh-time-stamp/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: method, args: args || {} }),
      }).then((r) => r.json()).catch((e) => ({ ok: false, reason: String(e && e.message !== undefined ? e.message : e) }));
    }

    const inject = ['slots'];

    const chipStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '3px 10px',
      borderRadius: 999,
      border: '1px solid var(--dsw-alias-divider, rgba(128,128,128,0.35))',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary, #8a8a8a)',
      fontSize: 12,
      lineHeight: '18px',
      cursor: 'pointer',
      fontFamily: 'inherit',
      whiteSpace: 'nowrap',
    };

    // ── 设置行的原生外观 ──
    // 与产品「通用设置」里的行逐值对齐（实测：行 padding 16px 0 + 底部 1px 分隔线、
    // 文本列 gap 4 + 右侧留 48px、标题 14/22/400、说明 12/18 且用 label-tertiary）。
    const ROW = { display: 'flex', alignItems: 'center', gap: 8, padding: '16px 0', borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.1))', width: '100%' };
    const ROW_TEXT = { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 auto', minWidth: 0, paddingRight: 48 };
    const ROW_TITLE = { fontSize: 14, lineHeight: '22px', fontWeight: 400, color: 'var(--dsw-alias-label-primary, #222)' };
    const ROW_DESC = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #999)' };

    // ── per-project toggle: session header, right-aligned utilities ──
    function TimeStampChip(props) {
      const [state, setState] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState(null);
      react.useEffect(() => {
        let alive = true;
        setState(null);
        setError(null);
        rpc('state', { sessionId: props.sessionId }).then((r) => {
          if (alive && r && r.ok === true) setState(r);
        }).catch(() => {});
        return () => { alive = false; };
      }, [props.sessionId]);
      if (state === null) return null;
      const enabled = state.enabled === true;
      const scopeName = state.workspaceId ? (state.title || '当前项目') : '全局默认';
      const flip = () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        rpc('set-enabled', { workspaceId: state.workspaceId, enabled: !enabled }).then((r) => {
          if (r && r.ok === true) {
            setState({ ...state, enabled: r.enabled });
          } else {
            setError((r && r.reason) || '写入失败');
          }
        }).then(() => setBusy(false));
      };
      const dotColor = error ? 'var(--dsw-alias-state-error-primary, #d92d20)' : (enabled ? 'var(--dsw-static-deepseek-500, #4d6bfe)' : 'var(--dsw-alias-label-caption, #9a9a9a)');
      const title = error
        ? '时间戳注入（' + scopeName + '）：' + error + '——点击重试'
        : '时间戳注入（' + scopeName + '）：当前' + (enabled ? '开' : '关') + '，点击切换。开启后，每个提问都会在模型上下文里附上接收时间。';
      return react.createElement('button', {
        onClick: flip,
        disabled: busy,
        title: title,
        style: chipStyle,
      }, [
        react.createElement('span', { key: 'd', style: { width: 8, height: 8, borderRadius: '50%', display: 'inline-block', flex: 'none', background: dotColor } }),
        react.createElement('span', { key: 't' }, error ? '写入失败' : ('时间戳 ' + (enabled ? '开' : '关'))),
      ]);
    }

    // ── global default row: Settings → General ──
    function DefaultRow() {
      const [enabled, setEnabled] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState(null);
      react.useEffect(() => {
        let alive = true;
        rpc('get-default', {}).then((r) => {
          if (alive && r && r.ok === true) setEnabled(r.enabled === true);
        }).catch(() => {});
        return () => { alive = false; };
      }, []);
      const flip = () => {
        if (busy || enabled === null) return;
        setBusy(true);
        setError(null);
        rpc('set-default', { enabled: !enabled }).then((r) => {
          if (r && r.ok === true) setEnabled(r.enabled === true);
          else setError((r && r.reason) || '写入失败');
        }).then(() => setBusy(false));
      };
      return react.createElement('div', { style: ROW }, [
        react.createElement('div', { key: 'l', style: ROW_TEXT }, [
          react.createElement('span', { key: 't', style: ROW_TITLE }, '时间戳注入'),
          react.createElement('span', { key: 'd', style: error ? { ...ROW_DESC, color: 'var(--dsw-alias-state-error-primary, #d92d20)' } : ROW_DESC }, error ? (error + '——点击重试') : '在每个用户提问后向模型注入接收时间（默认值；各项目可在会话顶部单独切换）'),
        ]),
        react.createElement('button', {
          key: 'b',
          onClick: flip,
          disabled: busy || enabled === null,
          title: error ? error : undefined,
          style: { ...chipStyle, flexShrink: 0, minWidth: 56, justifyContent: 'center', background: enabled ? 'var(--dsw-static-deepseek-500, #4d6bfe)' : 'transparent', color: enabled ? '#fff' : 'var(--dsw-alias-label-secondary, #8a8a8a)' },
        }, enabled === null ? '…' : (enabled ? '开' : '关')),
      ]);
    }

    // ── plugin body ──
    function apply(ctx) {
      const slots = ctx.get('slots');
      if (slots === undefined) return;
      slots.inject('conversation.session.header.utilities', () => slots.register(
        { name: 'conversation.session.header.utilities', id: 'time-stamp-toggle', order: 10 },
        (props) => TimeStampChip(props),
      ));
      slots.inject('settings.general.item', () => slots.register(
        { name: 'settings.general.item', id: 'time-stamp-default', order: 30 },
        () => DefaultRow(),
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
