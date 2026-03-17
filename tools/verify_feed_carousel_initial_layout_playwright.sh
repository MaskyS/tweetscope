#!/usr/bin/env bash
set -euo pipefail

PLAYWRIGHT_CLI_BIN="${PLAYWRIGHT_CLI_BIN:-/opt/homebrew/bin/playwright-cli}"
SESSION_ID="${SESSION_ID:-fc-layout-$RANDOM}"
TARGET_URL="${1:-http://127.0.0.1:5174/datasets/nosilverv-tweets/explore/scopes-001}"
API_HEALTH_URL="${API_HEALTH_URL:-http://127.0.0.1:3000/api/health}"

cleanup() {
  "$PLAYWRIGHT_CLI_BIN" -s="$SESSION_ID" close >/dev/null 2>&1 || true
}

trap cleanup EXIT

if ! command -v "$PLAYWRIGHT_CLI_BIN" >/dev/null 2>&1; then
  echo "playwright-cli not found at $PLAYWRIGHT_CLI_BIN" >&2
  exit 1
fi

curl -fsS "$TARGET_URL" >/dev/null
curl -fsS "$API_HEALTH_URL" >/dev/null

"$PLAYWRIGHT_CLI_BIN" -s="$SESSION_ID" open "$TARGET_URL" --browser=chrome >/dev/null

read -r -d '' PLAYWRIGHT_CODE <<'EOF' || true
async page => {
  const wait = (ms) => page.waitForTimeout(ms)
  const assert = (condition, message, extra = null) => {
    if (!condition) {
      const suffix = extra ? `\n${JSON.stringify(extra, null, 2)}` : ''
      throw new Error(`${message}${suffix}`)
    }
  }

  const waitFor = async (fn, timeoutMs = 30000, stepMs = 250) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const value = await fn()
      if (value) return value
      await wait(stepMs)
    }
    throw new Error('Timed out waiting for page state')
  }

  const getState = async () => page.evaluate(() => {
    const carousel = document.querySelector('div[class*="_carousel_"]')
    const list = document.querySelector('div[class*="_list_"]')
    const buttons = Array.from(
      document.querySelectorAll('div[class*="_list_"] button[data-topic-index]')
    )
    const active = buttons.find((button) => button.className.includes('_active_'))
    const mountedColumns = Array.from(
      document.querySelectorAll('div[class*="_columnOuter_"]')
    )
    const focusedColumns = mountedColumns
      .filter((column) => column.className.includes('_focused_'))
      .map((column) => column.querySelector('h3')?.innerText?.trim() ?? null)

    return {
      scrollLeft: carousel?.scrollLeft ?? null,
      listScrollTop: list?.scrollTop ?? null,
      activeTopicIndex: active ? Number(active.dataset.topicIndex) : null,
      activeText: active?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 140) ?? null,
      focusedColumnLabels: focusedColumns,
      firstMountedColumnLabel: mountedColumns[0]?.querySelector('h3')?.innerText?.trim() ?? null,
      visibleTopicButtons: buttons.slice(0, 14).map((button) => {
        const rect = button.getBoundingClientRect()
        return {
          topicIndex: Number(button.dataset.topicIndex),
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          height: Math.round(rect.height),
          text: button.innerText?.replace(/\s+/g, ' ').trim().slice(0, 80) ?? null,
        }
      }),
    }
  })

  const assertVisibleTopicButtonsDoNotOverlap = (buttons, message, state) => {
    assert(Array.isArray(buttons) && buttons.length >= 2, 'Not enough visible topic buttons to validate layout', state)
    const ordered = [...buttons].sort((a, b) => a.top - b.top)
    for (let i = 1; i < ordered.length; i += 1) {
      const prev = ordered[i - 1]
      const next = ordered[i]
      assert(next.top >= prev.bottom - 1, message, { state, prev, next })
      assert(next.height > 0, 'Virtualized topic button rendered with non-positive height', { state, next })
    }
  }

  let expandReady = false
  for (let attempt = 0; attempt < 80; attempt += 1) {
    expandReady = await page.evaluate(
      () => Boolean(document.querySelector('button[title="Expand to carousel"]'))
    )
    if (expandReady) break
    await wait(500)
  }
  assert(expandReady, 'Expand-to-carousel control did not render in time')

  await page.evaluate(() => document.querySelector('button[title="Expand to carousel"]')?.click())
  await waitFor(
    () => page.evaluate(() => Boolean(document.querySelector('input[placeholder="Search topics..."]')))
  )
  await wait(3000)

  const initialState = await getState()
  assert(initialState.scrollLeft === 0, 'Initial expanded carousel scrollLeft was not 0', initialState)
  assert(initialState.activeTopicIndex === 0, 'Initial expanded carousel active topic was not the first sorted topic', initialState)
  assert(initialState.focusedColumnLabels.length === 1, 'Initial expanded carousel did not render exactly one focused column', initialState)
  assert(initialState.focusedColumnLabels[0] === initialState.firstMountedColumnLabel,
    'Initial expanded carousel did not focus the first mounted column',
    initialState)
  assertVisibleTopicButtonsDoNotOverlap(
    initialState.visibleTopicButtons,
    'Visible virtualized topic buttons overlapped on initial render',
    initialState
  )

  await page.evaluate(() => {
    const list = document.querySelector('div[class*="_list_"]')
    list?.scrollTo({ top: 500, behavior: 'auto' })
  })
  await wait(800)

  const afterScrollState = await getState()
  assertVisibleTopicButtonsDoNotOverlap(
    afterScrollState.visibleTopicButtons,
    'Visible virtualized topic buttons overlapped after vertical list scroll',
    afterScrollState
  )

  console.log(JSON.stringify({
    url: page.url(),
    initialState,
    afterScrollState,
  }, null, 2))
}
EOF

"$PLAYWRIGHT_CLI_BIN" -s="$SESSION_ID" run-code "$PLAYWRIGHT_CODE"
