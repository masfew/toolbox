import { expect, test } from 'claude-code/testing'

const HINT = {
  plugin: 'usage-rings',
  component: 'PromptHint',
  requestId: 'hint',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
} as const

const BAND = {
  plugin: 'usage-rings',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const start = async ($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1]) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', (_, e) => ({
    value: {
      startedAt: 0,
      // The model's window is 1M; auto-compact is set to 500k, which the breakdown reports.
      context: {
        tokens: 84_000,
        window: 1_000_000,
        percent: 8,
        ...(e.breakdown ? { breakdown: { rawMaxTokens: 500_000 } } : {}),
      },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 75, resetsAt: new Date(Date.now() + 130 * 60_000).toISOString() },
        { kind: 'seven_day', percentUsed: 93, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
      ],
    },
  }))
  // The minute tick never comes due in a test.
  on('clock.every', () => new Promise<never>(() => {}))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}

test('rings colour by level in the desktop band', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /Context 17%/ }))?.text).toBe('Context 17%')
  expect((await ui.find({ type: 'Text', text: /5-hour 75%/ }))?.text).toBe('5-hour 75%')
  expect((await ui.find({ type: 'Text', text: /7-day 93%/ }))?.text).toBe('7-day 93%')
  expect((await ui.find({ type: 'Text', text: /84k \/ 500k/ }))?.text).toBe('84k / 500k')
  const strokes = (await ui.findAll({ type: 'Svg' })).map(
    svg => JSON.stringify(svg).match(/stroke=\\"(#[0-9A-F]+)\\"/)?.[1],
  )
  expect(strokes).toEqual(['#4A8FE7', '#E8873A', '#E5484D'])
  await ui.unmount()
})

test('terminal draws text bars', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /▰▱▱▱▱/ }))?.text).toContain('Context 17%')
  expect((await ui.find({ type: 'Text', text: /▰▰▰▰▱/ }))?.text).toContain('5-hour 75%')
  await ui.unmount()
})

test('desktop question card keeps the rings above it', async ($, on) => {
  // Stands for the engine, answering with its own question card.
  on('ui.render', () => ({ type: 'engine', ref: 0 }) as const)
  await start($, on)
  // The mount refuses a tree that drops the card or puts anything below it.
  const ui = await $.ui.mount({
    plugin: 'usage-rings',
    component: 'AskUserQuestion',
    requestId: 'ask',
    surface: 'desktop',
    props: {
      tool: 'AskUserQuestion',
      questions: [{ question: 'Pick one?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }],
    },
  })

  expect((await ui.find({ type: 'Text', text: /5-hour 75%/ }))?.text).toBe('5-hour 75%')
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(3)
  await ui.unmount()
})
