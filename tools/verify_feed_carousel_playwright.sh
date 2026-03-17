#!/usr/bin/env bash
set -euo pipefail

PLAYWRIGHT_CLI_BIN="${PLAYWRIGHT_CLI_BIN:-/opt/homebrew/bin/playwright-cli}"
SESSION_ID="${SESSION_ID:-fc-$RANDOM}"
TARGET_URL="${1:-http://127.0.0.1:5174/datasets/defenderofbasic/explore/scopes-001}"
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
  const assert = (condition, message, extra = null) => {
    if (!condition) {
      const suffix = extra ? `\n${JSON.stringify(extra, null, 2)}` : ''
      throw new Error(`${message}${suffix}`)
    }
  }
  const waitFor = async (fn, timeoutMs = 30000, stepMs = 250, label = 'page state') => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const value = await fn()
      if (value) return value
      await wait(stepMs)
    }
    throw new Error(`Timed out waiting for ${label}`)
  }

  const clusterButton = (text) =>
    page.locator('div[class*="_list_"] button[data-topic-index]').filter({ hasText: text }).first()

  const subclusterButton = (text) =>
    page.locator('div[class*="_list_"] [role="button"]').filter({ hasText: text }).first()

  const getState = async () => page.evaluate(() => {
    const carousel = document.querySelector('div[class*="_carousel_"]')
    const toc = document
      .querySelector('input[placeholder="Search topics..."]')
      ?.closest('div[class*="_container_"]')
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
    const events = window.__LATENT_SCOPE_FEED_CAROUSEL_DEBUG_EVENTS__ || []

    return {
      scrollLeft: carousel?.scrollLeft ?? null,
      tocClass: toc?.className ?? null,
      isStickyShell: toc?.className.includes('_stickyShell_') ?? false,
      isStickyVisible: toc?.className.includes('_stickyVisible_') ?? false,
      tocOpacity: toc ? getComputedStyle(toc).opacity : null,
      tocLeft: toc?.getBoundingClientRect().left ?? null,
      tocRight: toc?.getBoundingClientRect().right ?? null,
      activeTopicIndex: active ? Number(active.dataset.topicIndex) : null,
      activeText: active?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 140) ?? null,
      focusedColumnLabels: focusedColumns,
      firstMountedColumnLabel: mountedColumns[0]?.querySelector('h3')?.innerText?.trim() ?? null,
      visibleTopicButtons: buttons.slice(0, 12).map((button) => {
        const rect = button.getBoundingClientRect()
        return {
          topicIndex: Number(button.dataset.topicIndex),
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          height: Math.round(rect.height),
          text: button.innerText?.replace(/\s+/g, ' ').trim().slice(0, 80) ?? null,
        }
      }),
      sortTitle: document
        .querySelector('button[title="Descending"], button[title="Ascending"]')
        ?.getAttribute('title') ?? null,
      debugTail: events.slice(-6),
    }
  })

  const assertVisibleTopicButtonsDoNotOverlap = (buttons, message, state) => {
    if (!Array.isArray(buttons) || buttons.length < 2) return

    const ordered = [...buttons].sort((a, b) => a.top - b.top)
    for (let i = 1; i < ordered.length; i += 1) {
      const prev = ordered[i - 1]
      const next = ordered[i]
      if (next.top < prev.bottom - 1) {
        throw new Error(`${message}\n${JSON.stringify({ state, prev, next }, null, 2)}`)
      }
    }
  }

  const revealStickyToc = async () => {
    await page.mouse.move(20, 200)
    await wait(400)
    let state = await getState()
    if (state.isStickyVisible && state.tocOpacity === '1') return state

    await page.evaluate(() => {
      const hoverZone = document.querySelector('div[class*="_hoverZone_"]')
      if (!hoverZone) return
      const rect = hoverZone.getBoundingClientRect()
      const clientX = Math.round(rect.left + Math.min(20, rect.width / 2))
      const clientY = Math.round(rect.top + rect.height / 2)

      hoverZone.dispatchEvent(new MouseEvent('mouseover', {
        bubbles: true,
        clientX,
        clientY,
      }))
      hoverZone.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        clientX,
        clientY,
      }))
    })
    await wait(400)
    state = await getState()
    assert(
      state.isStickyVisible && state.tocOpacity === '1',
      'Sticky ToC did not become visible after hover reveal',
      state
    )
    return state
  }

  const hideStickyToc = async () => {
    await page.mouse.move(500, 200)
    await wait(1200)
    const state = await getState()
    assert(
      state.isStickyShell && !state.isStickyVisible && state.tocOpacity === '0',
      'Sticky ToC did not hide after pointer exit',
      state
    )
    return state
  }

  const getExpectedScrollTarget = async (topicIndex) => page.evaluate((nextTopicIndex) => {
    const carousel = document.querySelector('div[class*="_carousel_"]')
    if (!carousel) return null

    const columnWidth = 550
    const gap = 32
    const listWidth = 360
    const paddingLeft = Number.parseFloat(getComputedStyle(carousel).paddingLeft) || 0
    const viewportWidth = carousel.clientWidth || window.innerWidth
    const centerOffset = (viewportWidth - columnWidth) / 2
    const spacerWidth = Math.max(0, centerOffset - (paddingLeft + listWidth + gap))
    const trackOffset = paddingLeft + listWidth + gap + spacerWidth

    if (nextTopicIndex <= 0) return 0
    return Math.max(0, trackOffset + nextTopicIndex * (columnWidth + gap) - centerOffset)
  }, topicIndex)

  const waitForSnapAlignment = async (topicIndex, expectedScrollLeft) =>
    waitFor(
      () => page.evaluate(
        ({ nextTopicIndex, nextScrollLeft }) => {
          const carousel = document.querySelector('div[class*="_carousel_"]')
          const active = Array.from(
            document.querySelectorAll('div[class*="_list_"] button[data-topic-index]')
          ).find((button) => button.className.includes('_active_'))

          if (!carousel || !active) return null
          const activeTopicIndex = Number(active.dataset.topicIndex)
          if (activeTopicIndex !== nextTopicIndex) return null
          if (Math.abs(carousel.scrollLeft - nextScrollLeft) > 12) return null

          return {
            scrollLeft: carousel.scrollLeft,
            activeTopicIndex,
          }
        },
        { nextTopicIndex: topicIndex, nextScrollLeft: expectedScrollLeft }
      ),
      5000,
      100,
      `manual snap alignment for topic ${topicIndex}`
    )

  const setCarouselScroll = async (scrollLeft) => {
    await page.evaluate((nextScrollLeft) => {
      const carousel = document.querySelector('div[class*="_carousel_"]')
      carousel?.scrollTo({ left: nextScrollLeft, behavior: 'auto' })
    }, scrollLeft)
    await wait(1200)
  }

  await page.evaluate(() => {
    localStorage.setItem('debug:feed-carousel', '1')
    window.__LATENT_SCOPE_DEBUG_FEED_CAROUSEL__ = true
  })
  await page.reload()
  await wait(3000)

  let expandReady = false
  for (let attempt = 0; attempt < 40; attempt += 1) {
    expandReady = await page.evaluate(
      () => Boolean(document.querySelector('button[title="Expand to carousel"]'))
    )
    if (expandReady) break
    await wait(500)
  }
  assert(expandReady, 'Expand-to-carousel control did not render in time')

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
  await wait(2000)

  const initialState = await getState()
  assert(initialState.scrollLeft === 0,
    'Expanded carousel did not start at true scrollLeft = 0',
    initialState)
  assert(initialState.activeTopicIndex === 0,
    'Expanded carousel did not start with the first sorted topic active',
    initialState)
  assert(initialState.focusedColumnLabels.length === 1,
    'Expanded carousel did not render exactly one focused column on initial load',
    initialState)
  assert(initialState.focusedColumnLabels[0] === initialState.firstMountedColumnLabel,
    'Expanded carousel did not focus the first mounted column on initial load',
    initialState)
  assertVisibleTopicButtonsDoNotOverlap(
    initialState.visibleTopicButtons,
    'Visible topic buttons overlapped on initial expanded render',
    initialState
  )

  const expectedSecondTopicScrollLeft = await getExpectedScrollTarget(1)
  await setCarouselScroll(400)
  await waitForSnapAlignment(1, expectedSecondTopicScrollLeft)
  const snappedSecondTopicState = await getState()
  assert(snappedSecondTopicState.activeTopicIndex === 1,
    'Manual horizontal scroll did not snap focus to the second topic',
    { expectedSecondTopicScrollLeft, snappedSecondTopicState })
  assert(Math.abs((snappedSecondTopicState.scrollLeft ?? 0) - expectedSecondTopicScrollLeft) <= 12,
    'Manual horizontal scroll did not settle to the second topic center',
    { expectedSecondTopicScrollLeft, snappedSecondTopicState })

  await setCarouselScroll(120)
  await waitForSnapAlignment(0, 0)
  const snappedStartState = await getState()
  assert(snappedStartState.activeTopicIndex === 0,
    'Manual horizontal scroll near the start did not snap focus back to the first topic',
    snappedStartState)
  assert(snappedStartState.scrollLeft === 0,
    'Manual horizontal scroll near the start did not return to true start',
    snappedStartState)

  const resetTrials = []
  for (let trial = 0; trial < 3; trial += 1) {
    await page.evaluate(() => {
      window.__LATENT_SCOPE_FEED_CAROUSEL_DEBUG_EVENTS__ = []
    })

    await setCarouselScroll(1805)
    const beforeReveal = await revealStickyToc()
    await subclusterButton('Using emotions as information').click({ force: true })
    await wait(1000)
    const afterClick = await getState()
    const afterHide = await hideStickyToc()
    const state = { beforeReveal, afterClick, afterHide }
    resetTrials.push(state)

    assert(afterClick.scrollLeft !== null && afterClick.scrollLeft > 1200,
      'Sticky ToC subcluster click did not stay near the clicked cluster while hovered',
      state)
    assert(afterClick.isStickyVisible && afterClick.tocOpacity === '1',
      'Sticky ToC did not remain visible immediately after the subcluster click',
      state)
    assert(afterHide.scrollLeft !== null && afterHide.scrollLeft > 1200,
      'Sticky ToC subcluster click + mouse leave reset the carousel too far toward the start',
      state)
    assert(afterHide.isStickyShell && !afterHide.isStickyVisible,
      'Sticky ToC stayed pinned after pointer exit in reset regression check',
      state)
    assert(afterHide.activeText !== null && afterHide.activeText.includes('Pattern Consciousness'),
      'Active ToC cluster drifted away from the clicked cluster after sticky ToC exit',
      state)
  }

  await page.evaluate(() => {
    window.__LATENT_SCOPE_FEED_CAROUSEL_DEBUG_EVENTS__ = []
  })
  await setCarouselScroll(1805)
  await revealStickyToc()
  await subclusterButton('Using emotions as information').click({ force: true })
  await wait(1000)
  const hoveredState = await getState()
  assert(hoveredState.scrollLeft !== null && hoveredState.scrollLeft > 1200,
    'Hovered sticky ToC subcluster click did not land near the clicked cluster',
    hoveredState)
  assert(hoveredState.isStickyVisible,
    'Sticky ToC did not remain visible while the pointer stayed inside it',
    hoveredState)

  await hideStickyToc()
  const afterExitState = await getState()
  assert(afterExitState.scrollLeft !== null && afterExitState.scrollLeft > 1200,
    'Sticky ToC exit changed the carousel position after a successful subcluster jump',
    afterExitState)
  assert(afterExitState.isStickyShell && !afterExitState.isStickyVisible,
    'Sticky ToC did not collapse after pointer exit',
    afterExitState)

  await setCarouselScroll(1805)
  await revealStickyToc()
  await page.evaluate(() => {
    window.__LATENT_SCOPE_FEED_CAROUSEL_DEBUG_EVENTS__ = []
  })
  await page.evaluate(() => {
    const target = Array.from(document.querySelectorAll('div[class*="_list_"] button[data-topic-index]'))
      .find((button) => button.innerText.includes('Applying ML to decode animal vocalizations'))
    target?.click()
  })
  await wait(1800)
  const firstTopicState = await getState()
  assert(firstTopicState.scrollLeft === 0,
    'First topic click did not return the strip to the true start',
    firstTopicState)
  assert(firstTopicState.tocLeft === 0 && firstTopicState.tocRight === 360,
    'First topic click did not fully restore ToC visibility',
    firstTopicState)

  await setCarouselScroll(1805)
  await revealStickyToc()
  await page.evaluate(() => {
    window.__LATENT_SCOPE_FEED_CAROUSEL_DEBUG_EVENTS__ = []
  })
  await page.evaluate(() => {
    document
      .querySelector('button[title="Descending"], button[title="Ascending"]')
      ?.click()
  })
  await wait(1000)
  const sortHoverState = await getState()
  assert(sortHoverState.isStickyVisible && sortHoverState.tocOpacity === '1',
    'Sort toggle while hovered caused the sticky ToC to collapse',
    sortHoverState)

  const summary = {
    url: page.url(),
    snappedSecondTopicState,
    snappedStartState,
    resetTrials,
    hoveredState,
    afterExitState,
    firstTopicState,
    sortHoverState,
  }

  console.log(JSON.stringify(summary, null, 2))
}
EOF

"$PLAYWRIGHT_CLI_BIN" -s="$SESSION_ID" run-code "$PLAYWRIGHT_CODE"
