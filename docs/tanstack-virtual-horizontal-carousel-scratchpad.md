# TanStack Virtual Horizontal Carousel Scratchpad

Plan anchor: `docs/tanstack-virtual-horizontal-carousel-plan.md`

## Fresh-context summary

The task is to prepare a careful implementation of the TanStack Virtual horizontal carousel migration, not to code from memory or from the migration note alone.

The implementation must:

- preserve all current user-facing behavior in the expanded Explore carousel
- keep the sticky / hover-revealed / pinned ToC behavior intact
- keep direct far-jump navigation, per-column lazy loading, thread overlay, and current `FeedColumn` tweet rendering intact
- verify risks by actual counts and browser behavior, not by vibe or generic LLM assumptions
- consult primary docs, save the useful findings locally, and leave a durable scratchpad for post-compaction continuation

## Current code reality

### Important files

- `web/src/pages/V2/FullScreenExplore.jsx`
- `web/src/components/Explore/V2/Carousel/FeedCarousel.jsx`
- `web/src/components/Explore/V2/Carousel/TopicListSidebar.jsx`
- `web/src/components/Explore/V2/Carousel/FeedColumn.jsx`
- `web/src/hooks/useCarouselData.js`
- `tools/verify_feed_carousel_playwright.sh`

### What is true right now

- `FeedCarousel` still owns manual horizontal windowing.
- The scroll strip still uses native `scroll-snap-type: x mandatory`.
- The ToC is a real sibling inside the same horizontal scroll container.
- Sticky ToC behavior is a custom state machine in `FeedCarousel`, not a library concern.
- `FeedColumn` already has its own separate vertical progressive reveal.
- `@tanstack/react-virtual` is not currently present in `web/package.json`.
- There is no meaningful React component-test infra for this area.
- The only checked-in carousel regression guard is the live-browser Playwright CLI script.

## Official docs consulted and saved here

Primary sources:

- TanStack Virtual introduction: https://tanstack.com/virtual/latest/docs/introduction
- TanStack Virtual installation: https://tanstack.com/virtual/latest/docs/installation
- TanStack Virtual React adapter: https://tanstack.com/virtual/latest/docs/framework/react/react-virtual
- TanStack Virtual API: https://tanstack.com/virtual/latest/docs/api/virtualizer
- TanStack Virtual sticky example: https://tanstack.com/virtual/latest/docs/framework/react/examples/sticky
- TanStack Virtual infinite-scroll example: https://tanstack.com/virtual/latest/docs/framework/react/examples/infinite-scroll
- TanStack Virtual padding example: https://tanstack.com/virtual/latest/docs/framework/react/examples/padding
- TanStack Virtual smooth-scroll example: https://tanstack.com/virtual/latest/docs/framework/react/examples/smooth-scroll
- React `startTransition`: https://react.dev/reference/react/startTransition

### High-signal doc findings

#### Installation

- The official adapter package for this repo is `@tanstack/react-virtual`.

#### Introduction

- TanStack Virtual is headless and explicitly supports row, column, grid, and sticky use cases.
- That matches this migration: the carousel needs horizontal column virtualization, not opinionated layout replacement.

#### React adapter

- `useVirtualizer` returns a standard virtualizer configured for an element scroll container.
- The React adapter exposes `useFlushSync`, default `true`.
- `useFlushSync` exists to improve synchronous scroll accuracy, but the docs note it may be worth disabling for performance-sensitive or warning-prone scenarios.
- React 18 is in use here, so React 19-specific `flushSync` warnings are not an immediate blocker, but the option is relevant enough to record now.

#### Virtualizer API

- `onChange(instance, sync)` is the intended hook for virtualizer state changes.
- `sync === true` means scrolling is currently happening; `false` means scrolling has stopped or another non-scroll state change occurred.
- `horizontal: true` is the standard way to virtualize the column strip.
- `overscan` defaults to `1`; increasing it trades more mounted work for fewer blank-edge risks.
- `paddingStart` / `paddingEnd` define extra space in the virtual list itself.
- `scrollPaddingStart` / `scrollPaddingEnd` affect how `scrollToIndex` aligns targets.
- `getItemKey` should be overridden with a stable key rather than relying on the raw index.
- `scrollMargin` is the official way to express the offset between the scroll element start and the start of the virtualized list.
- The docs explicitly call out that absolute-positioned transforms should subtract `scrollMargin`.
- `useScrollendEvent` defaults to `false`; the library falls back to debounced `isScrolling` reset until scroll-end support is uniformly reliable.
- `shouldAdjustScrollPositionOnItemSizeChange` is specifically about dynamically measured item sizes diverging from estimates.
- `scrollToIndex` supports `align: 'center'`.

#### Smooth scrolling

- The API docs warn that during smooth scrolling the virtualizer only measures items within a buffer near the target.
- The docs say the preferred layout for smooth scrolling is block translation rather than independently absolutely positioning each item when dynamic measurement is involved.
- For this carousel, item width is fixed, so this is not a blocker, but it is still a guardrail against casually mixing smooth scroll and future dynamic width measurement.

#### Sticky example

- `rangeExtractor` is the official pattern when sticky items live inside the virtualized range.
- That is useful as a contrast case.
- It does not make the Explore ToC a good `rangeExtractor` candidate, because the ToC is not a sticky row inside the column list. It is a separate interactive control surface.

#### Infinite-scroll example

- The official pattern is to drive loading behavior from the currently rendered virtual items.
- That supports replacing the current `visibleStart` / `visibleEnd`-driven loading logic with `getVirtualItems()`-driven prefetch.

#### Padding example

- TanStack’s examples support absolute-positioned children inside a virtual track.
- The example is useful for confirming the general layout pattern, but for this repo the main thing to keep is the left-gutter geometry contract, not the exact example markup.

#### React `startTransition`

- The React docs position `startTransition` as appropriate for non-urgent updates.
- This supports using transitions selectively for non-critical visual bookkeeping if needed.
- It does not justify wrapping every scroll-driven state write in a transition without measurement.

## What must not regress

### Entry and geometry

- Entering expanded mode must still land at true start: ToC fully visible, `scrollLeft = 0`, first sorted topic selected.
- The left gutter must remain behaviorally identical: `LIST_WIDTH + GAP + spacerWidth + centering math` is currently part of the UX contract, not an incidental implementation detail.
- Clicking the first topic from a scrolled state must still restore the true start with the full ToC visible.

### ToC behavior

- The ToC must still scroll off naturally and then be recallable from the left-edge hover zone.
- Hover-revealed sticky ToC must still appear without shifting the strip.
- Clicking a cluster, subcluster, or sort control while the sticky ToC is visible must keep it visible through scroll completion.
- After that action completes, pointer exit must be allowed to hide the ToC without resetting the horizontal position.
- Search must remain list-only; it must not change mounted carousel content directly.
- Vertical auto-scroll of the active ToC entry must remain confined to the ToC list.

### Carousel content behavior

- Far jumps must still land in one motion.
- Sort changes must still reorder the ToC and update the scroll target correctly.
- `FeedColumn` rendering semantics must remain unchanged in phase 1.
- Progressive vertical reveal inside `FeedColumn` must remain unchanged.
- Subcluster filtering must still work.
- Thread overlay open/close must remain independent of the virtualizer rewrite.
- Load-more must still work for mounted columns.

## OOM and napkin-verification notes

### What is probably not the dominant cost

- Sorting the cluster list.
- Mapping sorted indices to original indices.
- Fixed-width horizontal item measurement.
- Constant-width `estimateSize`.

### What is probably the real hot path

- Re-rendering carousel state on scroll.
- Mounting and unmounting column subtrees.
- Fighting control systems between native scroll-snap and programmatic centering.
- Sticky-ToC layout mutations interacting with scroll/focus.

### Napkin checks to do before tuning

- Current real mounted-column budget is roughly 7 `FeedColumn`s plus placeholder slots, not the entire cluster list.
- Effective item width is `550 + 32 = 582px`.
- Approx visible-column count at common desktop widths should be checked rather than guessed:
  - `1280 / 582 ≈ 2.2`
  - `1440 / 582 ≈ 2.5`
  - `1728 / 582 ≈ 3.0`
- That means a TanStack overscan of `2` is plausibly in the same order of magnitude as the current mounted column count, but this should be verified in browser with actual `getVirtualItems().length`, not assumed.

### Practical implication

- Overscan is a tuning knob, not a moral choice.
- Start with the current-plan default only if the mounted item count stays in the same order as today and there are no visible blank-edge artifacts.

## LLM pitfall guardrails

- Do not assume the local migration note is the whole truth. Re-check the mounted code before each structural change.
- Do not assume a TanStack feature should be used just because it exists:
  - `rangeExtractor` is not automatically right for the ToC.
  - `measureElement` is not automatically needed for fixed-width columns.
  - `shouldAdjustScrollPositionOnItemSizeChange` is not automatically relevant when width is constant.
- Do not assume a theoretical OOM issue is real without counts.
- Do not treat current sticky-ToC behavior as optional polish. It is the main regression surface.
- Do not invent React component-test infra for this rewrite. That is not how this repo currently verifies frontend behavior.
- Do not keep native scroll-snap and virtualizer-owned centering in place together longer than necessary.
- Do not “optimize” away programmatic scroll completion guards until equivalent behavior is actually proven in browser.
- Do not widen scope into vertical tweet virtualization.
- Do not let future dynamic-width thinking contaminate phase 1; column width is fixed now.

## Recommended implementation order

### Phase 0: lock down invariants

- Treat `scrollLeft = 0` start semantics as a hard requirement.
- Keep `TopicListSidebar` outside the virtualized item range.
- Keep `FeedColumn` unchanged.
- Keep the existing `ResizeObserver`-based geometry measurement pattern.

### Phase 1: introduce TanStack without changing data shape

- Add `@tanstack/react-virtual`.
- Keep sorted/original index mapping exactly as-is.
- Add a horizontal virtualizer tied to the existing carousel scroll element.
- Feed it:
  - `count`
  - `horizontal: true`
  - fixed `estimateSize`
  - `gap`
  - stable `getItemKey`
  - `scrollMargin` derived from ToC + spacer geometry
  - `scrollPaddingStart` / `scrollPaddingEnd` for center alignment
- Keep the ToC and spacer region real siblings ahead of the virtualized track.

### Phase 2: move control to the virtualizer

- Replace manual window computation with `getVirtualItems()`.
- Replace manual far-jump queueing with `scrollToIndex`.
- Replace manual visible-range-driven loading with virtual-item-driven loading.
- Retune `visualSortedIndex` ownership using `onChange(instance, sync)`.

### Phase 3: remove overlapping systems

- Remove manual leading/trailing placeholder logic.
- Remove placeholder column rendering.
- Remove scroll-snap CSS after the virtualizer path is actually in charge.
- Re-run full browser regression after snap removal.

## Testing strategy

### What the repo supports today

- Browser-first regression via `tools/verify_feed_carousel_playwright.sh`
- Pure helper tests via `node:test`
- Static checks via `web` lint/typecheck

### What to use for this migration

- Primary regression guard: the checked-in Playwright CLI script
- Secondary regression guard: a small pure-helper test file if geometry / mapping helpers are extracted
- Final gate: manual browser pass on the live carousel

### Existing checked-in browser coverage

The current script already covers:

- sticky ToC subcluster click + mouse-leave no-reset
- sticky ToC hover/pin persistence
- first-topic return to true start
- sort-toggle while sticky ToC is hovered

### Tests to add if helper extraction happens

- sorted index -> original index mapping remains stable
- original index -> sorted index mapping remains stable
- centered-start offset math
- first-item special-case behavior
- virtual-item -> original-index loading set calculation

### Manual browser checklist for the implementation

- Open expanded mode and confirm true start.
- Click a far-away topic once and confirm one-step landing.
- Click a far-away subtopic once and confirm one-step landing plus filter application.
- Scroll away, reveal sticky ToC from the left edge, and confirm no horizontal drift.
- While sticky ToC is visible, click:
  - a topic
  - a subtopic
  - sort mode
  - sort direction
- Move the pointer out during and after those actions and confirm the strip does not reset.
- Click the first topic from a scrolled state and confirm full ToC restoration.
- Open and close thread overlay from a mounted column.
- Use load-more on a mounted column.
- Resize the viewport while expanded and confirm centering still works.

## Open questions to settle during implementation

- Should `visualSortedIndex` continue as local React state, or become a derivation from virtualizer state plus minimal bookkeeping?
- Does index `0` need an explicit `scrollToOffset(0)` path, or is `scrollToIndex(0, { align: 'center' })` sufficient once scroll padding and margin are correct?
- Is overscan `2` enough to eliminate visible blanking on fast trackpad flicks in this UI, or does the actual column subtree cost require a different setting?
- Should any scroll-driven visual bookkeeping be wrapped in `startTransition`, or is the adapter’s default synchronous behavior the better choice for this React 18 app?

## Concrete TODOs before or during coding

- [ ] Add `@tanstack/react-virtual`
- [ ] Extract geometry helpers if the virtualizer wiring starts duplicating math
- [ ] Log virtual item counts during manual verification on at least one real viewport
- [ ] Remove native snap only after virtualizer centering is verified
- [ ] Extend the Playwright smoke only where it improves confidence without duplicating the same assertion style
- [ ] Keep a short before/after note on mounted column counts and observed scroll behavior

## Implementation findings (2026-03-17)

### What actually mattered

- Horizontal column virtualization alone simplified the carousel code, but it did not materially reduce live DOM on `visakanv-tweets`.
- The real large-surface cost was the ToC itself:
  - pre-virtualization measurement showed about `2464` mounted topic buttons and about `26k` DOM nodes
  - mounted feed columns were already only `4-7`
- That means the real OOM-sized surface was the always-mounted ToC, not the horizontal column strip.

### What changed in the implementation

- `FeedCarousel` now uses TanStack Virtual for horizontal column mounting and offset-based jumps.
- `TopicListSidebar` now uses TanStack Virtual vertically inside the scrollable `.list` only.
- The sticky shell, search bar, sort controls, footer, hover reveal, and pinned-after-action behavior stayed outside the virtual range.
- Active ToC autoscroll was rewritten from DOM-rect math to filtered-index-based `scrollToIndex`, because the active row is not guaranteed to be mounted anymore.
- Topic buttons now expose `data-topic-index` so the Playwright scripts can target far-away ToC entries even when the list is virtualized.

### Verified behavior

- `tools/verify_feed_carousel_playwright.sh` passed after the final reveal-state fix.
- The reveal-state fix was necessary because the scroll-path optimization introduced a stale local reveal-ref bug; syncing the ref from committed React state removed that regression.

### Final visakanv measurement

Route:

- `http://127.0.0.1:5174/datasets/visakanv-tweets/explore/scopes-001`

Final verified measurement (`tools/measure_feed_carousel_playwright.sh ... 40`):

- jump to topic `40`: `2457ms`
- return to first topic: `2301ms`
- initial mounted columns: `4`
- jump mounted columns: `7`
- initial DOM nodes: `2372`
- jump DOM nodes: `2238`
- initial mounted topic buttons: `11`
- jump mounted topic buttons: `18`

Useful baseline comparisons from earlier runs:

- original manual-window carousel:
  - jump about `3233ms`
  - return about `2763ms`
  - DOM nodes about `26236`
- horizontal virtualization before ToC virtualization:
  - DOM stayed around `26k`
  - this confirmed the ToC was the real scaling problem

## Post-fix diagnosis: focused column vertical scroll

### Symptom

- On large datasets, focused columns could lose real inner vertical scrolling.
- That showed up as:
  - `Load more` looking broken
  - subcluster views not behaving like bounded scroll areas
  - the column body visually acting like it was expanding with content

### Root cause

- The horizontal TanStack virtual item wrapper in `FeedCarousel.jsx` was absolutely positioned but did not fully participate in the height chain.
- `FeedColumn` expects a constrained parent so `.tweetScroll` becomes the actual vertical scroller.
- Without that constraint, `.tweetScroll` could effectively size to content instead of staying bounded.

### Fix

- Added `display: flex`, `height: 100%`, and `minHeight: 0` to the per-column virtual item wrapper in `FeedCarousel.jsx`.
- Kept the earlier `FeedColumn.jsx` fix that sets the progressive-reveal `IntersectionObserver` root to `.tweetScroll` instead of the page viewport.

### Why this was the right diagnosis

The live browser probe on `visakanv-tweets` showed the corrected geometry after the wrapper-height fix:

- `tweetScrollClientHeight ≈ 617`
- `tweetScrollScrollHeight > 2000`
- `tweetScrollTop` successfully changed after programmatic scroll

That is the expected shape of a bounded inner scroller. Before the fix, the failing behavior was consistent with the scroll area growing with content instead.

### Docs alignment

- TanStack’s horizontal/dynamic examples use a bounded scroll element, a relative total-size track with full height, and absolutely positioned virtual children that also carry full-height sizing.
- Our previous wrapper diverged from that pattern in exactly the place that broke the column height chain.

## Browser coverage added after the fix

- `tools/verify_feed_carousel_initial_layout_playwright.sh`
  - catches initial expanded-state regressions
  - asserts `scrollLeft === 0`
  - asserts first topic is active and exactly one column is focused
  - asserts visible virtualized ToC rows do not overlap
- `tools/verify_feed_carousel_column_scroll_playwright.sh`
  - runs on `visakanv-tweets`
  - focuses a visible topic
  - verifies the focused column scrolls vertically
  - clicks `Load more` and verifies the column remains scrollable
  - selects a non-`All` subcluster and verifies the column remains scrollable

### Important test oracle correction

- The first attempt treated `Load more` as “rendered child count must increase”.
- That was too naive because `groupRowsByThread()` can regroup raw rows and subcluster filtering can change visible shape.
- The better invariant is: the focused column remains the focused column, stays bounded, and still scrolls vertically after topic focus, load-more, and subcluster selection.

## Post-fix diagnosis: horizontal snap restoration

### Symptom

- Manual horizontal scrolling no longer snapped the carousel to a centered column on release.
- Focus could still update while scrolling, but the resting position no longer matched the old snap behavior.

### Why native CSS snap was not the right restore

- The old implementation used native `scroll-snap-type` with in-flow carousel items.
- The TanStack version now renders columns as absolutely positioned virtual items inside a single sized track.
- That means native browser snap points are no longer a safe drop-in fit for the actual rendered structure.

### TanStack docs that mattered

- `onChange(instance, sync)` reports whether scrolling is still in progress; `sync === false` is the “scrolling has stopped” signal.
- `isScrollingResetDelay` exists specifically as a cross-browser fallback until `scrollend` is uniformly reliable.
- `useScrollendEvent` defaults to `false`, again because TanStack treats the debounced fallback as the more reliable cross-browser path today.

### Chosen fix

- Use TanStack Virtual’s scroll-stop detection to trigger a controlled nearest-column settle after manual horizontal scrolling.
- Keep live focus updates during drag/trackpad scroll.
- When scrolling goes idle:
  - compute the nearest sorted column index
  - compute its exact centered `scrollLeft`
  - update the focused topic to that same index if needed
  - smooth-scroll to that exact offset

This restores user-facing snap behavior while keeping focus and resting position aligned.

### Why this is lower-risk than reviving native snap

- It works with the current absolute virtual item layout.
- It does not require reintroducing a separate set of snap-marker DOM nodes.
- It avoids asking native snap and our programmatic ToC jumps to fight over the same scroll container.
- It keeps the start-of-strip special case intact: near-start release snaps back to true `scrollLeft = 0`, not a partial offset.

### Regression coverage added

- `tools/verify_feed_carousel_playwright.sh` now checks:
  - manual scroll to an in-between offset snaps to topic `1`
  - the resting `scrollLeft` matches the centered offset for that topic
  - focus shifts to that same topic
  - a near-start manual scroll snaps back to true start and focus `0`
