#!/usr/bin/env bash
set -euo pipefail

PLAYWRIGHT_CLI_BIN="${PLAYWRIGHT_CLI_BIN:-/opt/homebrew/bin/playwright-cli}"
SESSION_ID="${SESSION_ID:-fc-column-$RANDOM}"
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
  const wait = (ms) => page.waitForTimeout(ms)
  const assert = (condition, message, extra = null) => {
    if (!condition) {
      const suffix = extra ? `\n${JSON.stringify(extra, null, 2)}` : ''
      throw new Error(`${message}${suffix}`)
    }
  }

  const waitFor = async (label, fn, timeoutMs = 30000, stepMs = 250) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const value = await fn()
      if (value) return value
      await wait(stepMs)
    }
    throw new Error(`Timed out waiting for ${label}`)
  }

  const getFocusedColumnState = async () => page.evaluate(() => {
    const columns = Array.from(document.querySelectorAll('div[class*="_columnOuter_"]'))
    const focused = columns.find((column) => column.className.includes('_focused_')) ?? null
    const tweetScroll = focused?.querySelector('div[class*="_tweetScroll_"]') ?? null
    const feedList = focused?.querySelector('div[class*="_feedList_"]') ?? null
    const pillButtons = Array.from(
      focused?.querySelectorAll('div[class*="_pillBar_"] button') ?? []
    )
    const activePill = pillButtons.find((button) => button.className.includes('_active_')) ?? null
    const loadMoreButton = focused?.querySelector('button[class*="_loadMoreBtn_"]') ?? null
    const spinner = focused?.querySelector('div[class*="_spinner_"]') ?? null
    const activeTopicButton = Array.from(
      document.querySelectorAll('div[class*="_list_"] button[data-topic-index]')
    ).find((button) => button.className.includes('_active_')) ?? null

    return {
      mountedColumnLabels: columns.map((column) => column.querySelector('h3')?.innerText?.trim() ?? null),
      focusedLabel: focused?.querySelector('h3')?.innerText?.trim() ?? null,
      activeTopicIndex: activeTopicButton ? Number(activeTopicButton.dataset.topicIndex) : null,
      tweetScrollTop: tweetScroll?.scrollTop ?? null,
      tweetScrollHeight: tweetScroll?.scrollHeight ?? null,
      tweetClientHeight: tweetScroll?.clientHeight ?? null,
      feedChildCount: feedList?.children.length ?? null,
      pillTexts: pillButtons.map((button) => button.textContent?.replace(/\s+/g, ' ').trim() ?? null),
      activePillText: activePill?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      hasLoadMore: Boolean(loadMoreButton),
      loadMoreText: loadMoreButton?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      loading: Boolean(spinner),
    }
  })

  const settleCarouselScroll = async (timeoutMs = 15000) => {
    const start = Date.now()
    let last = await page.evaluate(
      () => document.querySelector('div[class*="_carousel_"]')?.scrollLeft ?? 0
    )
    let stableCount = 0

    while (Date.now() - start < timeoutMs) {
      await wait(150)
      const next = await page.evaluate(
        () => document.querySelector('div[class*="_carousel_"]')?.scrollLeft ?? 0
      )
      stableCount = Math.abs(next - last) < 1 ? stableCount + 1 : 0
      last = next
      if (stableCount >= 4) return next
    }

    return last
  }

  const getVisibleTopicIndices = async () => page.evaluate(() =>
    Array.from(document.querySelectorAll('div[class*="_list_"] button[data-topic-index]'))
      .map((button) => Number(button.dataset.topicIndex))
      .filter((value) => Number.isInteger(value))
  )

  const focusTopicByIndex = async (topicIndex) => {
    await waitFor(
      `topic button ${topicIndex}`,
      () => page.evaluate(
        (nextTopicIndex) =>
          Boolean(document.querySelector(`button[data-topic-index="${nextTopicIndex}"]`)),
        topicIndex
      )
    )
    await page.evaluate((nextTopicIndex) => {
      document.querySelector(`button[data-topic-index="${nextTopicIndex}"]`)?.click()
    }, topicIndex)
    await settleCarouselScroll()
    await wait(700)
    return getFocusedColumnState()
  }

  const setFocusedColumnScrollTop = async (top) => {
    await page.evaluate((nextTop) => {
      const focused = Array.from(document.querySelectorAll('div[class*="_columnOuter_"]'))
        .find((column) => column.className.includes('_focused_'))
      const tweetScroll = focused?.querySelector('div[class*="_tweetScroll_"]')
      tweetScroll?.scrollTo({ top: nextTop, behavior: 'auto' })
    }, top)
    await wait(400)
    return getFocusedColumnState()
  }

  const waitForFocusedColumnIdle = async (label) =>
    waitFor(label, async () => {
      const state = await getFocusedColumnState()
      return state.focusedLabel && !state.loading ? state : null
    }, 30000, 300)

  const clickFocusedSubcluster = async () => {
    await page.evaluate(() => {
      const focused = Array.from(document.querySelectorAll('div[class*="_columnOuter_"]'))
        .find((column) => column.className.includes('_focused_'))
      const buttons = Array.from(focused?.querySelectorAll('div[class*="_pillBar_"] button') ?? [])
      const target = buttons.find((button, index) => index > 0)
      target?.click()
    })
    await wait(300)
    return waitForFocusedColumnIdle('focused column idle after subcluster selection')
  }

  const clickFocusedLoadMore = async () => {
    await page.evaluate(() => {
      const focused = Array.from(document.querySelectorAll('div[class*="_columnOuter_"]'))
        .find((column) => column.className.includes('_focused_'))
      focused?.querySelector('button[class*="_loadMoreBtn_"]')?.click()
    })

    await waitFor('focused column load-more completion', async () => {
      const state = await getFocusedColumnState()
      return state.focusedLabel && !state.loading ? state : null
    }, 20000, 300)
    await wait(300)
    return getFocusedColumnState()
  }

  const isScrollable = (state) =>
    Number.isFinite(state?.tweetScrollHeight) &&
    Number.isFinite(state?.tweetClientHeight) &&
    state.tweetScrollHeight > state.tweetClientHeight + 80

  let expandReady = false
  for (let attempt = 0; attempt < 120; attempt += 1) {
    expandReady = await page.evaluate(
      () => Boolean(document.querySelector('button[title="Expand to carousel"]'))
    )
    if (expandReady) break
    await wait(500)
  }
  assert(expandReady, 'Expand-to-carousel control did not render in time')

  await waitFor('base explore view hydration before expand', () =>
    page.evaluate(() => {
      const hasExpand = Boolean(document.querySelector('button[title="Expand to carousel"]'))
      const embedButtons = document.querySelectorAll(
        'button[title="View as Embed"], button[title="Show official X embed"]'
      ).length
      return hasExpand && embedButtons > 0
    }),
    45000,
    500
  )

  let sidebarReady = false
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await page.evaluate(() => document.querySelector('button[title="Expand to carousel"]')?.click())
    await wait(500)
    sidebarReady = await page.evaluate(
      () => Boolean(document.querySelector('input[placeholder="Search topics..."]'))
    )
    if (sidebarReady) break
  }
  assert(sidebarReady, 'Expanded carousel sidebar did not render in time')
  await waitFor('expanded carousel topics and focused column', async () => {
    const state = await getFocusedColumnState()
    const visibleIndices = await getVisibleTopicIndices()
    return state.focusedLabel && visibleIndices.length > 1
      ? { state, visibleIndices }
      : null
  }, 30000, 500)

  const visibleTopicIndices = await getVisibleTopicIndices()
  const initialState = await getFocusedColumnState()

  assert(initialState.focusedLabel, 'Expanded carousel did not have an initial focused column', {
    initialState,
    visibleTopicIndices,
  })

  let targetTopicIndex = null
  let focusedState = null
  for (const topicIndex of visibleTopicIndices) {
    if (topicIndex === initialState.activeTopicIndex) continue

    await focusTopicByIndex(topicIndex)
    const candidateState = await waitForFocusedColumnIdle('focused column idle after topic focus')
    if (
      candidateState.activeTopicIndex === topicIndex &&
      Array.isArray(candidateState.pillTexts) &&
      candidateState.pillTexts.length > 1 &&
      candidateState.hasLoadMore
    ) {
      targetTopicIndex = topicIndex
      focusedState = candidateState
      break
    }
  }

  assert(targetTopicIndex != null && focusedState,
    'Expanded carousel did not render a visible alternate topic with subclusters and load-more',
    { initialState, visibleTopicIndices, focusedState })

  const preLoadMoreScrollState = await setFocusedColumnScrollTop(
    Math.min(
      320,
      Math.max(120, (focusedState.tweetScrollHeight ?? 0) - (focusedState.tweetClientHeight ?? 0))
    )
  )
  assert(preLoadMoreScrollState.focusedLabel === focusedState.focusedLabel,
    'Focused column changed while testing vertical scroll after topic focus',
    { focusedState, preLoadMoreScrollState, targetTopicIndex })
  assert((preLoadMoreScrollState.tweetScrollTop ?? 0) > 50,
    'Focused column was not vertically scrollable after topic focus',
    { focusedState, preLoadMoreScrollState, targetTopicIndex })

  const afterLoadMoreState = await clickFocusedLoadMore()
  assert(afterLoadMoreState.focusedLabel === focusedState.focusedLabel,
    'Focused column changed after clicking load more',
    { focusedState, afterLoadMoreState, targetTopicIndex })
  assert(isScrollable(afterLoadMoreState),
    'Focused column was no longer vertically scrollable after clicking load more',
    { focusedState, afterLoadMoreState, targetTopicIndex })

  const afterLoadMoreScrollState = await setFocusedColumnScrollTop(
    Math.min(
      320,
      Math.max(120, (afterLoadMoreState.tweetScrollHeight ?? 0) - (afterLoadMoreState.tweetClientHeight ?? 0))
    )
  )
  assert(afterLoadMoreScrollState.focusedLabel === focusedState.focusedLabel,
    'Focused column changed while testing vertical scroll after loading more tweets',
    { afterLoadMoreState, afterLoadMoreScrollState, targetTopicIndex })
  assert((afterLoadMoreScrollState.tweetScrollTop ?? 0) > 50,
    'Focused column did not scroll vertically after loading more tweets',
    { afterLoadMoreState, afterLoadMoreScrollState, targetTopicIndex })

  const afterSubclusterState = await clickFocusedSubcluster()
  assert(afterSubclusterState.focusedLabel === focusedState.focusedLabel,
    'Focused column changed after subcluster selection',
    { focusedState, afterSubclusterState, targetTopicIndex })
  assert(afterSubclusterState.activePillText && !/^All\b/.test(afterSubclusterState.activePillText),
    'Focused column did not activate a non-All subcluster pill',
    { focusedState, afterSubclusterState, targetTopicIndex })
  assert(
    isScrollable(afterSubclusterState),
    'Focused column was no longer vertically scrollable after subcluster selection',
    { afterLoadMoreState, afterSubclusterState, targetTopicIndex }
  )

  const afterSubclusterScrollState = await setFocusedColumnScrollTop(
    Math.min(
      320,
      Math.max(120, (afterSubclusterState.tweetScrollHeight ?? 0) - (afterSubclusterState.tweetClientHeight ?? 0))
    )
  )
  assert(afterSubclusterScrollState.focusedLabel === focusedState.focusedLabel,
    'Focused column changed while testing vertical scroll after subcluster selection',
    { afterSubclusterState, afterSubclusterScrollState, targetTopicIndex })
  assert((afterSubclusterScrollState.tweetScrollTop ?? 0) > 50,
    'Focused column did not scroll vertically after subcluster selection',
    { afterSubclusterState, afterSubclusterScrollState, targetTopicIndex })

  console.log(JSON.stringify({
    url: page.url(),
    visibleTopicIndices,
    targetTopicIndex,
    initialState,
    focusedState,
    preLoadMoreScrollState,
    afterLoadMoreState,
    afterLoadMoreScrollState,
    afterSubclusterState,
    afterSubclusterScrollState,
  }, null, 2))
}
EOF

"$PLAYWRIGHT_CLI_BIN" -s="$SESSION_ID" run-code "$PLAYWRIGHT_CODE"
