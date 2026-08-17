// dsh-time-stamp — Client 半部（动态 Cordis 插件）
//
// 用法：在 DSH 会话中通过 cordis_define 创建动态插件时，
// 把本文件的全部内容原样作为 code.client 参数提交
// （plugin.kind: "new", idPrefix: "tstmp"），
// host.js 的内容作为 code.host，然后 cordis_run 激活。
//
// 本文件是纯 JavaScript 函数体（无 import / require / JSX / TS），
// 运行在浏览器端的动态插件求值器中，可用全局：ctx / React /
// host / styles / console。

// Time Stamp — client half: per-project toggle in the session header and a
// global default row in Settings -> General. Both read/write through the
// Package-private Host RPC (host.call), so no extra storage on the page.
// Write failures are surfaced on the control instead of failing silently.
return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

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
    }

    // Per-project toggle: session header, right-aligned utilities.
    slots.inject('conversation.session.header.utilities', () => slots.register(
      { name: 'conversation.session.header.utilities', id: 'time-stamp-toggle', order: 10 },
      (props) => {
        const [state, setState] = React.useState(null)
        const [busy, setBusy] = React.useState(false)
        const [error, setError] = React.useState(null)
        React.useEffect(() => {
          let alive = true
          setState(null)
          setError(null)
          host.call('state', { sessionId: props.sessionId }).then((r) => {
            if (alive && r && r.ok === true) setState(r)
          }).catch((e) => {
            console.error('[time-stamp] state read failed', e)
            if (alive) setError('状态读取失败')
          })
          return () => { alive = false }
        }, [props.sessionId])
        if (state === null) return null
        const enabled = state.enabled === true
        const scope = state.workspaceId ? (state.title || '当前项目') : '全局默认'
        const flip = () => {
          if (busy) return
          setBusy(true)
          setError(null)
          host.call('set-enabled', { workspaceId: state.workspaceId, enabled: !enabled }).then((r) => {
            if (r && r.ok === true) {
              setState({ ...state, enabled: r.enabled })
            } else {
              setError((r && r.reason) || '写入失败')
              console.error('[time-stamp] set-enabled rejected: ' + ((r && r.reason) || 'unknown'))
            }
          }).catch((e) => {
            setError('写入失败')
            console.error('[time-stamp] set-enabled failed', e)
          }).then(() => setBusy(false))
        }
        const dotColor = error ? 'var(--dsw-alias-state-error-primary, #d92d20)' : (enabled ? 'var(--dsw-static-deepseek-500, #4d6bfe)' : 'var(--dsw-alias-label-caption, #9a9a9a)')
        const title = error
          ? '时间戳注入（' + scope + '）：' + error + '——点击重试'
          : '时间戳注入（' + scope + '）：当前' + (enabled ? '开' : '关') + '，点击切换。开启后，每个提问都会在模型上下文里附上接收时间。'
        return React.createElement('button', {
          onClick: flip,
          disabled: busy,
          title: title,
          style: chipStyle,
        }, [
          React.createElement('span', { key: 'd', style: { width: 8, height: 8, borderRadius: '50%', display: 'inline-block', flex: 'none', background: dotColor } }),
          React.createElement('span', { key: 't' }, error ? '写入失败' : ('时间戳 ' + (enabled ? '开' : '关'))),
        ])
      },
    ))

    // Global default row: Settings -> General.
    slots.inject('settings.general.item', () => slots.register(
      { name: 'settings.general.item', id: 'time-stamp-default', order: 30 },
      () => {
        const [enabled, setEnabled] = React.useState(null)
        const [busy, setBusy] = React.useState(false)
        const [error, setError] = React.useState(null)
        React.useEffect(() => {
          let alive = true
          host.call('get-default', {}).then((r) => {
            if (alive && r && r.ok === true) setEnabled(r.enabled === true)
          }).catch((e) => {
            console.error('[time-stamp] get-default failed', e)
            if (alive) setError('读取失败')
          })
          return () => { alive = false }
        }, [])
        const flip = () => {
          if (busy || enabled === null) return
          setBusy(true)
          setError(null)
          host.call('set-default', { enabled: !enabled }).then((r) => {
            if (r && r.ok === true) {
              setEnabled(r.enabled === true)
            } else {
              setError((r && r.reason) || '写入失败')
              console.error('[time-stamp] set-default rejected: ' + ((r && r.reason) || 'unknown'))
            }
          }).catch((e) => {
            setError('写入失败')
            console.error('[time-stamp] set-default failed', e)
          }).then(() => setBusy(false))
        }
        return React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, width: '100%' } }, [
          React.createElement('div', { key: 'l', style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } }, [
            React.createElement('span', { key: 't', style: { fontSize: 14, lineHeight: '20px', color: 'var(--dsw-alias-label-primary, #222)' } }, '时间戳注入'),
            React.createElement('span', { key: 'd', style: { fontSize: 12, lineHeight: '16px', color: error ? 'var(--dsw-alias-state-error-primary, #d92d20)' : 'var(--dsw-alias-label-tertiary, #999)' } }, error ? (error + '——点击重试') : '在每个用户提问后向模型注入接收时间（默认值；各项目可在会话顶部单独切换）'),
          ]),
          React.createElement('button', {
            key: 'b',
            onClick: flip,
            disabled: busy || enabled === null,
            title: error ? error : undefined,
            style: { ...chipStyle, minWidth: 56, justifyContent: 'center', background: enabled ? 'var(--dsw-static-deepseek-500, #4d6bfe)' : 'transparent', color: enabled ? '#fff' : 'var(--dsw-alias-label-secondary, #8a8a8a)' },
          }, enabled === null ? '…' : (enabled ? '开' : '关')),
        ])
      },
    ))
  },
}
