#!/usr/bin/env bash
set -euo pipefail

PLAYWRIGHT_CLI_BIN="${PLAYWRIGHT_CLI_BIN:-/opt/homebrew/bin/playwright-cli}"
SESSION_ID="${SESSION_ID:-fc-diagnose-$RANDOM}"
TARGET_URL="${1:-http://127.0.0.1:5174/datasets/visakanv-tweets/explore/scopes-001}"
API_HEALTH_URL="${API_HEALTH_URL:-http://127.0.0.1:3000/api/health}"

cleanup() {
  "$PLAYWRIGHT_CLI_BIN" -s="$SESSION_ID" close >/dev/null 2>&1 || true
}

trap cleanup EXIT

if ! command -v "$PLAYWRIGHT_CLI_BIN" >/dev/null 2>&1; then
  echo "playwright-cli not found at $PLAYWRIGHT_CLI_BIN" >&2
  exit 1
fi

TARGET_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' "$TARGET_URL")"
if [ "$TARGET_STATUS" != "200" ]; then
  echo "Frontend not reachable at $TARGET_URL (status $TARGET_STATUS)" >&2
  exit 1
fi

API_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' "$API_HEALTH_URL")"
if [ "$API_STATUS" != "200" ] && [ "$API_STATUS" != "429" ]; then
  echo "API not reachable at $API_HEALTH_URL (status $API_STATUS)" >&2
  exit 1
fi

"$PLAYWRIGHT_CLI_BIN" -s="$SESSION_ID" open "$TARGET_URL" --browser=chrome >/dev/null

read -r -d '' PLAYWRIGHT_CODE <<'EOF' || true
async page => {
  const wait = ms => page.waitForTimeout(ms)

  const waitFor = async (label, fn, timeoutMs = 45000, stepMs = 500) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const value = await fn()
      if (value) return value
      await wait(stepMs)
    }
    throw new Error(`Timed out waiting for ${label}`)
  }

  const getState = async () => page.evaluate(() => {
    const columns = Array.from(document.querySelectorAll('div[class*="_columnOuter_"]'))
    const focused = columns.find(column => column.className.includes('_focused_')) ?? null
    const column = focused?.querySelector('div[class*="_column_"]') ?? null
    const tweetScroll = focused?.querySelector('div[class*="_tweetScroll_"]') ?? null
    const feedList = focused?.querySelector('div[class*="_feedList_"]') ?? null
    const activeTopic = Array.from(
      document.querySelectorAll('div[class*="_list_"] button[data-topic-index]')
    ).find(button => button.className.includes('_active_')) ?? null
    const pillButtons = Array.from(
      focused?.querySelectorAll('div[class*="_pillBar_"] button') ?? []
    )
    const activePill = pillButtons.find(button => button.className.includes('_active_')) ?? null
    const loadMoreButton = focused?.querySelector('button[class*="_loadMoreBtn_"]') ?? null
    const spinner = focused?.querySelector('div[class*="_spinner_"]') ?? null

    return {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      mountedColumnLabels: columns.map(column => column.querySelector('h3')?.innerText?.trim() ?? null),
      focusedLabel: focused?.querySelector('h3')?.innerText?.trim() ?? null,
      activeTopicIndex: activeTopic ? Number(activeTopic.dataset.topicIndex) : null,
      activePillText: activePill?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      pillCount: pillButtons.length,
      hasLoadMore: Boolean(loadMoreButton),
      loading: Boolean(spinner),
      feedChildCount: feedList?.children.length ?? null,
      columnOuterRectHeight: focused?.getBoundingClientRect().height ?? null,
      columnRectHeight: column?.getBoundingClientRect().height ?? null,
      tweetScrollRectHeight: tweetScroll?.getBoundingClientRect().height ?? null,
      tweetScrollClientHeight: tweetScroll?.clientHeight ?? null,
      tweetScrollScrollHeight: tweetScroll?.scrollHeight ?? null,
      tweetScrollTop: tweetScroll?.scrollTop ?? null,
      bodyScrollHeight: document.body.scrollHeight,
      bodyClientHeight: document.body.clientHeight,
    }
  })

  const focusTopic = async (topicIndex) => {
    await waitFor(`topic ${topicIndex} button`, () =>
      page.evaluate(nextTopicIndex =>
        Boolean(document.querySelector(`button[data-topic-index="${nextTopicIndex}"]`)),
      topicIndex)
    )
    await page.evaluate(nextTopicIndex => {
      document.querySelector(`button[data-topic-index="${nextTopicIndex}"]`)?.click()
    }, topicIndex)
    return waitFor(`topic ${topicIndex} focus`, async () => {
      const state = await getState()
      return state.activeTopicIndex === topicIndex && state.focusedLabel ? state : null
    }, 30000, 400)
  }

  const clickLoadMore = async () => {
    await page.evaluate(() => {
      const focused = Array.from(document.querySelectorAll('div[class*="_columnOuter_"]'))
        .find(column => column.className.includes('_focused_'))
      focused?.querySelector('button[class*="_loadMoreBtn_"]')?.click()
    })
    return waitFor('focused column to become idle after load more', async () => {
      const state = await getState()
      return state.focusedLabel && !state.loading ? state : null
    }, 25000, 300)
  }

  const scrollFocusedColumn = async top => {
    await page.evaluate(nextTop => {
      const focused = Array.from(document.querySelectorAll('div[class*="_columnOuter_"]'))
        .find(column => column.className.includes('_focused_'))
      const tweetScroll = focused?.querySelector('div[class*="_tweetScroll_"]')
      tweetScroll?.scrollTo({ top: nextTop, behavior: 'auto' })
    }, top)
    await wait(600)
    return getState()
  }

  await wait(35000)
  await waitFor('expand button', () =>
    page.evaluate(() => Boolean(document.querySelector('button[title="Expand to carousel"]')))
  )
  await page.evaluate(() => document.querySelector('button[title="Expand to carousel"]')?.click())
  await waitFor('expanded sidebar', () =>
    page.evaluate(() => Boolean(document.querySelector('input[placeholder="Search topics..."]')))
  )
  await waitFor('focused column after expand', async () => {
    const state = await getState()
    return state.focusedLabel ? state : null
  })

  const visibleTopicIndices = await page.evaluate(() =>
    Array.from(document.querySelectorAll('div[class*="_list_"] button[data-topic-index]'))
      .map(button => Number(button.dataset.topicIndex))
      .filter(value => Number.isInteger(value))
  )
  const initialState = await getState()
  const targetTopicIndex = visibleTopicIndices.find(topicIndex => topicIndex !== initialState.activeTopicIndex) ?? 1
  const focusedState = await focusTopic(targetTopicIndex)
  const afterFirstLoadMore = focusedState.hasLoadMore ? await clickLoadMore() : null
  const afterSecondLoadMore =
    afterFirstLoadMore?.hasLoadMore ? await clickLoadMore() : null
  const afterScrollState = await scrollFocusedColumn(300)

  return {
    url: page.url(),
    visibleTopicIndices,
    targetTopicIndex,
    initialState,
    focusedState,
    afterFirstLoadMore,
    afterSecondLoadMore,
    afterScrollState,
  }
}
EOF

"$PLAYWRIGHT_CLI_BIN" -s="$SESSION_ID" run-code "$PLAYWRIGHT_CODE"
