#!/usr/bin/env bash
set -euo pipefail

PLAYWRIGHT_CLI_BIN="${PLAYWRIGHT_CLI_BIN:-/opt/homebrew/bin/playwright-cli}"
SESSION_ID="${SESSION_ID:-fc-measure-$RANDOM}"
TARGET_URL="${1:-http://127.0.0.1:5174/datasets/visakanv-tweets/explore/scopes-001}"
TARGET_BUTTON_INDEX="${2:-40}"
API_HEALTH_URL="${API_HEALTH_URL:-http://127.0.0.1:3000/api/health}"

cleanup() {
  "$PLAYWRIGHT_CLI_BIN" -s="$SESSION_ID" close >/dev/null 2>&1 || true
}

trap cleanup EXIT

if ! command -v "$PLAYWRIGHT_CLI_BIN" >/dev/null 2>&1; then
  echo "playwright-cli not found at $PLAYWRIGHT_CLI_BIN" >&2
  exit 1
fi

if ! curl -fsS "$TARGET_URL" >/dev/null; then
  echo "Frontend not reachable at $TARGET_URL" >&2
  exit 1
fi

if ! curl -fsS "$API_HEALTH_URL" >/dev/null; then
  echo "API not reachable at $API_HEALTH_URL" >&2
  exit 1
fi

"$PLAYWRIGHT_CLI_BIN" -s="$SESSION_ID" open "$TARGET_URL" --browser=chrome >/dev/null

read -r -d '' PLAYWRIGHT_CODE <<'EOF' || true
async page => {
  const wait = (ms) => page.waitForTimeout(ms)

  const waitFor = async (fn, timeoutMs = 30000, stepMs = 250) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const value = await fn()
      if (value) return value
      await wait(stepMs)
    }
    throw new Error('Timed out waiting for page state')
  }

  const normalizeText = (value) => value?.replace(/\s+/g, ' ').trim().slice(0, 160) ?? null

  const getButtons = async () => page.evaluate(() =>
    Array.from(document.querySelectorAll('div[class*="_list_"] button[data-topic-index]'))
      .map((button) => ({
        text: button.innerText,
        isActive: button.className.includes('_active_'),
        topicIndex: Number(button.dataset.topicIndex),
      }))
      .sort((a, b) => a.topicIndex - b.topicIndex)
  )

  const getState = async () => page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('div[class*="_list_"] button[data-topic-index]'))
    const active = buttons.find((button) => button.className.includes('_active_'))
    const carousel = document.querySelector('div[class*="_carousel_"]')

    return {
      scrollLeft: carousel?.scrollLeft ?? null,
      mountedColumns: document.querySelectorAll('div[class*="_columnOuter_"]').length,
      tweetItems: document.querySelectorAll('div[class*="_feedList_"] > *').length,
      domNodes: document.querySelectorAll('*').length,
      activeText: active?.innerText ?? null,
      buttonCount: buttons.length,
    }
  })

  const ensureTopicButtonMounted = async (topicIndex) => {
    await page.evaluate((nextTopicIndex) => {
      const list = document.querySelector('div[class*="_list_"]')
      if (!list) return

      const estimatedRowHeight = 120
      list.scrollTo({
        top: Math.max(0, nextTopicIndex * estimatedRowHeight - list.clientHeight / 2),
        behavior: 'auto',
      })
    }, topicIndex)

    await waitFor(() =>
      page.evaluate(
        (nextTopicIndex) => Boolean(document.querySelector(`button[data-topic-index="${nextTopicIndex}"]`)),
        topicIndex
      )
    )
  }

  const settleScroll = async (predicate = null, timeoutMs = 15000) => {
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
      const isStable = predicate ? predicate(next) : Math.abs(next - last) < 1
      stableCount = isStable ? stableCount + 1 : 0
      last = next
      if (stableCount >= 4) return next
    }

    return last
  }

  let expandReady = false
  for (let attempt = 0; attempt < 80; attempt += 1) {
    expandReady = await page.evaluate(
      () => Boolean(document.querySelector('button[title="Expand to carousel"]'))
    )
    if (expandReady) break
    await wait(500)
  }

  if (!expandReady) {
    throw new Error('Expand-to-carousel control did not render in time')
  }

  await page.evaluate(() => document.querySelector('button[title="Expand to carousel"]')?.click())
  await waitFor(
    () => page.evaluate(() => Boolean(document.querySelector('input[placeholder="Search topics..."]')))
  )
  await wait(3000)

  const requestedIndex = Number(__TARGET_BUTTON_INDEX__)
  const initialState = await getState()
  const lastIndex = Math.max(0, Number(initialState.buttonCount) - 1)
  const clampedIndex = Number.isInteger(requestedIndex)
    ? Math.max(0, requestedIndex)
    : 40

  await ensureTopicButtonMounted(clampedIndex)
  const buttons = await getButtons()
  const targetText = normalizeText(
    buttons.find((button) => button.topicIndex === clampedIndex)?.text
  )

  await ensureTopicButtonMounted(0)
  const firstButtons = await getButtons()
  const firstText = normalizeText(
    firstButtons.find((button) => button.topicIndex === 0)?.text
  )

  if (!targetText || !firstText) {
    throw new Error('Could not find ToC buttons to measure')
  }

  const jumpStart = Date.now()
  await ensureTopicButtonMounted(clampedIndex)
  await page.evaluate((topicIndex) => {
    document.querySelector(`button[data-topic-index="${topicIndex}"]`)?.click()
  }, clampedIndex)
  const jumpedScrollLeft = await settleScroll()
  const jumpDurationMs = Date.now() - jumpStart
  await wait(500)
  const afterJumpState = await getState()

  const returnStart = Date.now()
  await ensureTopicButtonMounted(0)
  await page.evaluate(() => {
    document.querySelector('button[data-topic-index="0"]')?.click()
  })
  const returnedScrollLeft = await settleScroll((value) => value === 0)
  const returnDurationMs = Date.now() - returnStart
  await wait(500)
  const afterReturnState = await getState()

  return {
    url: page.url(),
    requestedIndex,
    targetIndex: clampedIndex,
    targetText,
    firstText,
    jumpDurationMs,
    jumpedScrollLeft,
    returnDurationMs,
    returnedScrollLeft,
    initialState: {
      ...initialState,
      activeText: normalizeText(initialState.activeText),
    },
    afterJumpState: {
      ...afterJumpState,
      activeText: normalizeText(afterJumpState.activeText),
    },
    afterReturnState: {
      ...afterReturnState,
      activeText: normalizeText(afterReturnState.activeText),
    },
  }
}
EOF

PLAYWRIGHT_CODE="${PLAYWRIGHT_CODE//__TARGET_BUTTON_INDEX__/$TARGET_BUTTON_INDEX}"

"$PLAYWRIGHT_CLI_BIN" -s="$SESSION_ID" run-code "$PLAYWRIGHT_CODE"
