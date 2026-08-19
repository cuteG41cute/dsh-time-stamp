// dsh-time-stamp — Client half (static / composition plugin)
//
// Browser bundle consumed by the client module loader (window.__ModuleLoader__).
// Reads and writes the Host-registered 'time-stamp' settings namespace through
// the settingsScope service — no custom RPC, no zod, survives restarts.
window.__ModuleLoader__.load({
  id: 'dsh-time-stamp',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    let react = require('react');

    // ── settings namespace owned by the Host half ──
    const NS = 'time-stamp';

    const inject = ['slots', 'settingsScope'];

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

    /** Subscribe one component to the settings scope snapshot. */
    function useScopeSnapshot(scope) {
      const [snap, setSnap] = react.useState(null);
      react.useEffect(() => {
        const update = () => setSnap(scope.getSnapshot());
        update();
        return scope.subscribe(update);
      }, [scope]);
      return snap;
    }

    // ── per-project toggle: session header, right-aligned utilities ──
    function TimeStampChip(scope, props) {
      const snap = useScopeSnapshot(scope);
      const [busy, setBusy] = react.useState(false);
      let workspace = null;
      if (typeof props.useWorkspaces === 'function') {
        // The selector hook REQUIRES a selector argument (its uSES shim calls
        // it unconditionally); calling it bare throws "w is not a function".
        const wsState = props.useWorkspaces((s) => s);
        const items = wsState && Array.isArray(wsState.items) ? wsState.items : [];
        workspace = items.find((w) => w && Array.isArray(w.sessionIds) && w.sessionIds.indexOf(props.sessionId) !== -1) || null;
      }
      if (!snap || !snap.value || typeof snap.value !== 'object') return null;
      const value = snap.value;
      const projects = value.projects && typeof value.projects === 'object' ? value.projects : {};
      const enabled = workspace !== null && typeof projects[workspace.id] === 'boolean'
        ? projects[workspace.id]
        : value.defaultEnabled === true;
      const scopeName = workspace !== null ? (workspace.title || '当前项目') : '全局默认';
      const flip = () => {
        if (busy) return;
        setBusy(true);
        const next = !enabled;
        const pending = workspace !== null
          ? scope.write({ op: 'set', path: ['projects', workspace.id], value: next })
          : scope.set('defaultEnabled', next);
        pending.then(() => setBusy(false), () => setBusy(false));
      };
      return react.createElement('button', {
        onClick: flip,
        disabled: busy,
        title: '时间戳注入（' + scopeName + '）：当前' + (enabled ? '开' : '关') + '，点击切换。开启后，每个提问都会在模型上下文里附上接收时间。',
        style: chipStyle,
      }, [
        react.createElement('span', { key: 'd', style: { width: 8, height: 8, borderRadius: '50%', display: 'inline-block', flex: 'none', background: enabled ? 'var(--dsw-static-deepseek-500, #4d6bfe)' : 'var(--dsw-alias-label-caption, #9a9a9a)' } }),
        react.createElement('span', { key: 't' }, '时间戳 ' + (enabled ? '开' : '关')),
      ]);
    }

    // ── global default row: Settings → General ──
    function DefaultRow(scope) {
      const snap = useScopeSnapshot(scope);
      const [busy, setBusy] = react.useState(false);
      if (!snap || !snap.value || typeof snap.value !== 'object') return null;
      const enabled = snap.value.defaultEnabled === true;
      const flip = () => {
        if (busy) return;
        setBusy(true);
        scope.set('defaultEnabled', !enabled).then(() => setBusy(false), () => setBusy(false));
      };
      return react.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, width: '100%' } }, [
        react.createElement('div', { key: 'l', style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } }, [
          react.createElement('span', { key: 't', style: { fontSize: 14, lineHeight: '20px', color: 'var(--dsw-alias-label-primary, #222)' } }, '时间戳注入'),
          react.createElement('span', { key: 'd', style: { fontSize: 12, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #999)' } }, '在每个用户提问后向模型注入接收时间（默认值；各项目可在会话顶部单独切换）'),
        ]),
        react.createElement('button', {
          key: 'b',
          onClick: flip,
          disabled: busy,
          style: { ...chipStyle, minWidth: 56, justifyContent: 'center', background: enabled ? 'var(--dsw-static-deepseek-500, #4d6bfe)' : 'transparent', color: enabled ? '#fff' : 'var(--dsw-alias-label-secondary, #8a8a8a)' },
        }, enabled ? '开' : '关'),
      ]);
    }

    // ── plugin body ──
    function apply(ctx) {
      const slots = ctx.get('slots');
      if (slots === undefined) return;
      const scope = ctx.settingsScope.bind({ namespace: NS, decode: (v) => v });
      slots.inject('conversation.session.header.utilities', () => slots.register(
        { name: 'conversation.session.header.utilities', id: 'time-stamp-toggle', order: 10 },
        (props) => TimeStampChip(scope, props),
      ));
      slots.inject('settings.general.item', () => slots.register(
        { name: 'settings.general.item', id: 'time-stamp-default', order: 30 },
        () => DefaultRow(scope),
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
