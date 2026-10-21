import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import type { Limit, Usage } from '../types'

const usage = atom({ plugin: 'usage-rings', key: 'usage' } as const, null)
const now = atom({ plugin: 'usage-rings', key: 'now' } as const, 0)

// Same scheme as the app's own context ring: blue, then orange near the limit, red when critical.
const WARN = 70
const CRITICAL = 90
const BLUE = '#4A8FE7'
const ORANGE = '#E8873A'
const RED = '#E5484D'

const colorFor = (percent: number) =>
  percent >= CRITICAL ? RED : percent >= WARN ? ORANGE : BLUE

const ring = (percent: number, color: string) => {
  const r = 8
  const c = 2 * Math.PI * r
  const arc = (c * Math.min(Math.max(percent, 0), 100)) / 100
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">` +
    `<circle cx="10" cy="10" r="${r}" fill="none" stroke="${color}" stroke-opacity="0.25" stroke-width="3"/>` +
    `<circle cx="10" cy="10" r="${r}" fill="none" stroke="${color}" stroke-width="3" ` +
    `stroke-dasharray="${arc.toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 10 10)"/>` +
    `</svg>`
  )
}

const bar = (percent: number) => {
  const filled = Math.round(Math.min(Math.max(percent, 0), 100) / 20)
  return '▰'.repeat(filled) + '▱'.repeat(5 - filled)
}

const tokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`

const timeLeft = (resetsAt: string | undefined, at: number) => {
  if (!resetsAt) return ''
  const minutes = Math.max(0, Math.round((Date.parse(resetsAt) - at) / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `resets in ${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m left`
  return `${minutes}m left`
}

type Gauge = { label: string; percent: number | undefined; detail: string }

const gauges = (u: Usage, at: number): Gauge[] => {
  const limit = (kind: string): Limit | undefined =>
    u.rateLimits.find(l => l.kind === kind)
  const five = limit('five_hour')
  const seven = limit('seven_day')
  return [
    {
      label: 'Context',
      percent: u.context.percent,
      detail:
        u.context.tokens === undefined
          ? `of ${tokens(u.context.window)}`
          : `${tokens(u.context.tokens)} / ${tokens(u.context.window)}`,
    },
    { label: '5-hour', percent: five?.percentUsed, detail: timeLeft(five?.resetsAt, at) },
    { label: '7-day', percent: seven?.percentUsed, detail: timeLeft(seven?.resetsAt, at) },
  ]
}

const toUsage = (e: Usage, window = e.context.window): Usage => ({
  context: {
    tokens: e.context.tokens,
    window,
    percent:
      e.context.tokens === undefined || window === e.context.window
        ? e.context.percent
        : Math.round((e.context.tokens / window) * 100),
  },
  rateLimits: e.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
})

// Measures context against the compaction window (the auto-compact setting, e.g. 500k), as the
// app's own context menu does, rather than the model's full window. `summary` estimates locally
// and sends no requests; only its `rawMaxTokens` is used.
const measure = async ($: EngineInterface): Promise<Usage> => {
  const u = await $.session.usage({ breakdown: 'summary' })
  return toUsage(u, u.context.breakdown?.rawMaxTokens)
}

const shown = (g: Gauge) => (g.percent === undefined ? '–' : `${Math.round(g.percent)}%`)

// Ring chips, for surfaces that draw SVG.
const rings = ({ Box, Text, Svg }: Elements['desktop'], list: Gauge[]) => (
  <Box flexDirection="row" alignItems="center" gap={2} flexWrap="wrap">
    {list.map(g => (
      <Box key={g.label} flexDirection="row" alignItems="center" gap={1}>
        <Svg
          source={ring(g.percent ?? 0, colorFor(g.percent ?? 0))}
          alt={`${g.label} ${shown(g)}`}
        />
        <Box flexDirection="column">
          <Text size="footnote">
            {g.label} {shown(g)}
          </Text>
          <Text size="caption" dimColor>
            {g.percent === undefined && g.label !== 'Context' ? 'no reading yet' : g.detail}
          </Text>
        </Box>
      </Box>
    ))}
  </Box>
)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const u = await measure($)
    await update($, usage, () => u)
    await update($, now, () => Date.now())
    // Keeps the reset countdowns current between responses.
    $.clock.every(60_000, () => update($, now, () => Date.now()))
    return result
  })

  on('session.measure', async ($, e, next) => {
    const u = await measure($)
    await update($, usage, () => u)
    await update($, now, () => Date.now())
    return next(e)
  })

  // The desktop app draws no line under the prompt box, so there the rings sit in the band above it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.surface !== 'desktop') return next(e)
    const u = (await read($, usage)) ?? (await measure($))
    return rings($.ui.resolve(e), gauges(u, (await read($, now)) || Date.now()))
  })

  // The question card replaces the prompt box (and its band) on desktop, so the rings sit above
  // the card instead. The engine's own card must be the tree's last node.
  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const card = await next(e)
    if (e.surface !== 'desktop') return card
    const u = (await read($, usage)) ?? (await measure($))
    const els = $.ui.resolve(e)
    return (
      <els.Box flexDirection="column" gap={1}>
        {rings(els, gauges(u, (await read($, now)) || Date.now()))}
        {card}
      </els.Box>
    )
  })

  // The terminal's hint line under the prompt box, drawn as coloured text bars.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const u = (await read($, usage)) ?? (await measure($))
    const list = gauges(u, (await read($, now)) || Date.now())
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" gap={2} flexWrap="wrap">
        {list.map(g => (
          <Text key={g.label}>
            <Text color={colorFor(g.percent ?? 0)}>{bar(g.percent ?? 0)}</Text>
            <Text dimColor>
              {' '}
              {g.label} {shown(g)}
              {g.detail ? ` · ${g.detail}` : ''}
            </Text>
          </Text>
        ))}
        {e.props.hint ? <Text dimColor>{e.props.hint}</Text> : null}
      </Box>
    )
  })
}
