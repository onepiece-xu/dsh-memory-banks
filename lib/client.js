// dsh-memory-banks — BROWSER half: a settings.section panel over the host route.
//
// Loaded through package.json `dsh.client` + `exports["./client"]`: the module
// loader bundles this file into the client roster, so `require` resolves the
// official client packages — never import them with bare ESM `import` statements.
window.__ModuleLoader__.load({
  id: 'dsh-memory-banks',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect } = React
    const h = React.createElement

    const NS = 'dsh-memory-banks'
    const zh = {
      nav: '记忆（hermes memory）',
      loading: '加载中…',
      error: '读取失败（宿主路由未就绪）',
      empty: '还没有任何记忆。让模型调用 memory 工具写入，或直接编辑 ~/.dsh/storages/dsh_memory_banks.json。',
      hint: '数据来自宿主路由 /dsh-memory-banks/stats，落盘于 $DSH_HOME/storages/dsh_memory_banks.json。',
      injected: '已注入系统提示',
      policyOnly: '仅策略注入（默认）',
    }
    const en = {
      nav: 'Memory (hermes)',
      loading: 'Loading…',
      error: 'Could not read the host route',
      empty: 'No memories yet. Have the model call the memory tool, or edit ~/.dsh/storages/dsh_memory_banks.json.',
      hint: 'Served by the host route /dsh-memory-banks/stats; stored in $DSH_HOME/storages/dsh_memory_banks.json.',
      injected: 'injected into the system prompt',
      policyOnly: 'policy-only (default)',
    }

    let t = (k) => k
    const setT = (fn) => { t = fn }

    // Styling: colors go through --dsw-alias-* tokens; literals are fallbacks only.
    const S = {
      box: { padding: '4px 2px', color: 'var(--dsw-alias-label-primary, #c9d1d9)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      row: { margin: '10px 0 0', fontSize: '13px', lineHeight: '1.6' },
      bar: { height: '6px', borderRadius: '3px', background: 'var(--dsw-alias-bg-layer-1, #0d1117)', border: '1px solid var(--dsw-alias-border-l1, #30363d)', overflow: 'hidden', marginTop: '4px' },
      fill: { height: '100%', background: 'var(--dsw-alias-button-primary-fill, #2f81f7)' },
      pre: { background: 'var(--dsw-alias-bg-layer-1, #0d1117)', border: '1px solid var(--dsw-alias-border-l1, #30363d)', borderRadius: '6px', padding: '10px 12px', fontSize: '12.5px', overflow: 'auto' },
      hint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #8b949e)' },
      error: { color: 'var(--dsw-alias-state-error-primary, #f85149)' },
    }

    function Panel() {
      const [state, setState] = useState({ status: 'loading', data: null })
      useEffect(() => {
        fetch('/dsh-memory-banks/stats')
          .then((r) => r.json())
          .then((data) => setState({ status: 'ok', data }))
          .catch(() => setState({ status: 'error', data: null }))
      }, [])

      if (state.status === 'loading') return h('div', { style: S.box }, t('loading'))
      if (state.status === 'error') return h('div', { style: { ...S.box, ...S.error } }, t('error'))

      const { banks = [], entries = [], total = 0, injected } = state.data
      return h('div', { style: S.box, 'data-dsh-plugin': 'dsh-memory-banks', 'data-dsh-surface': 'settings-modal' },
        h('div', { style: S.row }, `${total} ${total === 1 ? 'entry' : 'entries'} · ${injected ? t('injected') : t('policyOnly')}`),
        ...banks.map((bank) => {
          const percent = bank.limit > 0 ? Math.min(100, Math.round((bank.chars / bank.limit) * 100)) : 0
          return h('div', { key: bank.bank, style: S.row, 'data-dsh-part': 'bank' },
            h('div', null, `${bank.bank.toUpperCase()} — ${bank.entries} ${bank.entries === 1 ? 'entry' : 'entries'} · ${bank.usage}`),
            h('div', { style: S.bar }, h('div', { style: { ...S.fill, width: `${percent}%` } })),
          )
        }),
        entries.length > 0
          ? h('pre', { style: S.pre, 'data-dsh-part': 'code-block' }, entries.map((entry) => `${entry.category ? `[${entry.category}] ` : ''}${entry.text}`).join('\n'))
          : h('p', { style: S.row }, t('empty')),
        h('p', { style: { ...S.hint, marginTop: '10px' } }, t('hint')),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-memory-banks: dicts')
          const bound = ctx.locale.bind(NS)
          setT(bound)
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'dsh-memory-banks',
            order: 70,
            label: () => bound('nav'),
            locale: NS,
          }, Panel))
        } catch (e) {
          console.error('[dsh-memory-banks] apply failed:', e)
        }
      },
    }
  },
})
