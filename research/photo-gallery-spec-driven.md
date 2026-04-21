# Photo Gallery Spec-Driven Trial

This is a private experiment packet for asking fresh agents whether Freerange-style static facts make the `photo-gallery` rebuild less wobbly.

The worker should only read Vibescript docs plus this packet. It should not inspect the existing `demos/photo-gallery` implementation or older photo-gallery spec experiments.

## Worker Prompt

You are rebuilding the Vibescript `photo-gallery` demo from docs and this spec only.

Read these first:

- `/Users/chenglou/github/vibescript/AGENTS.md`
- `/Users/chenglou/github/vibescript/docs/ui.md`
- `/Users/chenglou/github/vibescript/docs/Animation.md`
- `/Users/chenglou/github/vibescript/docs/Input.md`
- `/Users/chenglou/github/vibescript/docs/Scrolling.md`
- `/Users/chenglou/github/vibescript/docs/Image.md`
- `/Users/chenglou/github/vibescript/docs/router.md`
- `/Users/chenglou/github/vibescript/docs/z-index-depth-management.md`
- `/Users/chenglou/github/vibescript/docs/drafts/layout-geometry.md`
- `/Users/chenglou/github/vibescript/docs/drafts/verification.md`
- `/Users/chenglou/github/vibescript/docs/drafts/automating-browsers.md`
- this packet

Do not inspect:

- `/Users/chenglou/github/vibescript/demos/photo-gallery`
- `/Users/chenglou/github/vibescript/todos/demos_with_specs/photo-gallery`
- `/Users/chenglou/github/vibescript/todos/demos_with_specs/spec-*/*/photo-gallery`

Build only inside the target folder the main thread gives you.

## Product

Build a photo gallery with two modes:

- grid mode: responsive scrollable cards
- line mode: one focused image centered in a horizontal strip, neighbors on the same line

The focused image id lives in `window.location.hash`. Opening line mode sets the hash. Dismissing line mode clears it. Browser back/forward should follow the hash.

Use a dark navy page with rounded dark cards and a fixed GitHub-style link.

## Data

Use this exact data:

```ts
export type PhotoData = {
  id: string
  w: number
  h: number
  prompt: string
}

export const photoGalleryData: PhotoData[] = [
  {id: 'd228330c-7364-497b-994f-a37467ae436a/0_0', w: 2048, h: 2048, prompt: 'Miniature watermelon delicately balanced on fingertip'},
  {id: '7b5301ca-ef01-44bd-8bcc-4473c945aaaf/0_0', w: 1792, h: 2688, prompt: 'Hourglass heart, liquid, grand canyon background, fleeting, ephemerality of time'},
  {id: '96ff81dd-fa46-43c0-b681-35b7cd8eb700/0_0', w: 1792, h: 2688, prompt: 'A phone held extremely close against an xray of a skeleton sitting on a sofa, side by side view'},
  {id: '077ddfbf-4f1a-437f-909e-073ec48beae0/0_0', w: 1344, h: 896, prompt: 'Eclipse in a tiny keychain bottle, dangling around a walking woman\'s purse, dynamic pose, macro photography'},
  {id: 'e1d06d80-68ca-4081-9ca2-73f5ba7333cc/0_3', w: 1536, h: 768, prompt: 'Tetris monuments in lord of the rings setting'},
  {id: '196ff609-69c8-47be-8d92-e9ba9db95e2c/0_3', w: 848, h: 1424, prompt: 'Peaceful prehistoric marine lagaxy life, adventure, bold outlines, bold colors, psychedelic swirls patterns'},
  {id: 'daa6883b-75ae-4805-9fe8-d394006ca8ca/0_1', w: 1024, h: 1024, prompt: 'Apple WWDC promo, dan mumford'},
  {id: '0dcaf55a-6ece-42b1-a0b3-eb753d108415/0_3', w: 1424, h: 848, prompt: 'Everything everywhere all at once, bold outlines'},
  {id: 'cfd235ab-89b2-4834-9544-19768f160d2a/0_1', w: 1344, h: 896, prompt: 'Cute and fluffy marshmallow modern mansion'},
  {id: 'ab740a8e-54af-452a-9b74-7b8cb233c025/0_0', w: 1024, h: 1024, prompt: 'Voronoi 3D printed cup taking roots'},
  {id: 'bcf32fdc-6d81-40f0-9063-d67cb402ea2a/0_0', w: 1344, h: 1024, prompt: 'Marble sculpture of an orange, museum gallery, exhibit'},
  {id: 'eb145f80-0196-4557-8560-e33637a3a807/0_0', w: 864, h: 1728, prompt: 'hourglass heart, liquid, grand canyon background'},
  {id: '604af437-f76b-4c7f-b778-1a3bf6ad663b/0_0', w: 1024, h: 1024, prompt: 'Golden retriever rising from the thick smokes, silhouette, contour'},
  {id: 'b6beb80d-b006-45e0-a06d-5e482b541571/0_0', w: 2304, h: 1536, prompt: 'Jupiter sitting on a chair on Saturn'},
  {id: '30d33a33-9b5b-4947-b813-4d0c5c2f9939/0_0', w: 1536, h: 1024, prompt: 'Chinese mid autumn festival on Neptune, surrealism'},
  {id: 'fb622e95-814d-4f74-8ac0-04d266c8387d/0_0', w: 1664, h: 2432, prompt: 'eclipse in a bottle'},
  {id: '733a5b94-3f35-4357-8ef5-645d1a9bb942/0_0', w: 1024, h: 1536, prompt: 'silk-like silhouette of koi fish, abstract wall paper, volumetric lighting'},
  {id: '2ca7a0f7-9153-45ce-be2b-1fc89327f61b/0_0', w: 2304, h: 1536, prompt: 'futuristic qipao, pink seamless astronaut skirt, sitting cross-legged at a floating space cafe, looking at camera, high angle, depth of field'},
  {id: '890a8dbb-93f6-4934-a92f-7dde390410e0/0_0', w: 1024, h: 1536, prompt: 'website landing page of a company with photos of streets and tiles'},
  {id: '11048abd-2c7e-42de-929b-bad5d810b3a3/0_0', w: 1024, h: 1024, prompt: 'dead tree and castle shaped like the silhouette of a skull, negative space'},
  {id: 'a812ad46-f902-427e-804b-68f5a55f2264/0_0', w: 1024, h: 1024, prompt: 'closed up macrophotography of a bowl of asian dessert'},
  {id: '4481ad84-444d-4761-adb1-15d470f216da/0_0', w: 1536, h: 1536, prompt: 'the cutest little cartoon octopus wearing a cap in a bathtub, she\'s playing with a toy boat, studio lighting, closed-up, hyperrealistic, photoshoot, tilt shift, contrast, intricate details'},
  {id: '50be9117-b2f5-482f-b61f-46477ed6184e/0_0', w: 1024, h: 1536, prompt: 'three-body problem, cinematic'},
  {id: '39428453-9b30-4998-a3d6-4668b4e2621f/0_0', w: 1536, h: 1536, prompt: 'super mario gundam'},
]
```

Image URLs:

- low-res: `https://cdn.midjourney.com/${id}_384_N.webp`
- high-res: `https://cdn.midjourney.com/${id}.webp`

## Exact Metrics

- grid side padding: `32`
- grid gap: `24`
- grid top padding: `40`
- max columns: `7`
- target minimum card width: about `220`
- line left strip: `100`
- line right strip: `100`
- line neighbor scale: `0.7`
- line gap between cards: `52`
- line bottom gap: `28`
- grid caption visible height: `44`
- line caption visible height: `64`
- caption bottom padding: `8`
- dismiss restore: focused row should land with about `40` pixels above it

Grid image caps:

- landscape: max image height is `boxMaxSizeX`
- square: max image height is `boxMaxSizeX * 0.85`
- portrait: max image height is `boxMaxSizeX * 1.05`

Then:

```ts
imageSizeX = min(naturalWidth, boxMaxSizeX, imageMaxSizeY * aspectRatio)
imageSizeY = imageSizeX / aspectRatio
layoutHeight = imageSizeY + visibleCaptionHeight + captionBottomPadding
```

## Interaction Truths

- Clicking the image area in grid mode enters line mode.
- Clicking a caption in grid mode selects the full caption text and stays in grid mode.
- In line mode, the left `100` px strip focuses the previous item.
- In line mode, the right `100` px strip focuses the next item.
- In line mode, the middle area dismisses back to grid.
- Line-mode hit areas are based on stable layout geometry, not current animated image edges.
- Grid mode mounts only visible or near-visible cards.
- Line mode locks underlying scroll.
- Pure resize should not create fake motion for items that stay in the same grid slot.

## Source-Owned Static Facts

Use ordinary pure helpers for geometry and state routing. Put `@fit` comments on the helpers where the fact is actually earned by source.

These facts should be checkable from source:

```ts
/** @fit
 * given windowSizeX: 320..2000
 * result.cols: int 1..7
 * result.boxMaxSizeX: 0..2000
 */
function gridColumnsAndBox(windowSizeX: number) {
  // your code
}

/** @fit
 * given x: -10000..10000
 * given y: -10000..10000
 * given sizeX: 0..10000
 * given sizeY: 0..10000
 * result.x == x
 * result.y == y
 * result.sizeX == sizeX
 * result.sizeY == sizeY
 */
function rect(x: number, y: number, sizeX: number, sizeY: number) {
  return {x, y, sizeX, sizeY}
}

/** @fit
 * given focused: int 1..1000
 * result: int 0..999
 * result == focused - 1
 */
function previousLineTarget(focused: number) {
  return focused - 1
}

/** @fit
 * given focused: int 0..999
 * result: int 1..1000
 * result == focused + 1
 */
function nextLineTarget(focused: number) {
  return focused + 1
}

/** @fit
 * given windowSizeX: 320..2000
 * given windowSizeY: 320..2000
 * given scrollY: -100000..100000
 * result.left.box.x == 0
 * result.left.box.y == scrollY
 * result.left.box.sizeX == 100
 * result.left.box.sizeY == windowSizeY
 * result.right.box.x == windowSizeX - 100
 * result.right.box.y == scrollY
 * result.right.box.sizeX == 100
 * result.right.box.sizeY == windowSizeY
 */
function lineHitAreaBoxes(windowSizeX: number, windowSizeY: number, scrollY: number) {
  // your code
}
```

The exact helper names can change. The point is the proof boundary:

- column count and box width are source-owned geometry
- rect construction copies its inputs
- left/right target helpers encode the index math, while the nullable edge cases stay in ordinary app control flow
- hit-area boxes are stable layout geometry, not animation
- helper contracts should be small enough that a bad arithmetic change makes the checker complain

Do not put `@fit` on browser-owned facts like native selection, scroll physics, CDN image timing, or DOM paint.

## Browser-Owned Reports

Browser checks should use page-owned semantic reports, not screenshots and not runner-side layout guesses.

Required final `phase: 'ready'` reports:

- `navigation-hash-sync`: line mode remains open, focused id matches the expected target, hash matches that id, scroll is locked
- `caption-selection`: selected text equals the full caption, focused id stays null
- `dismiss-to-row`: line mode is closed, hash is clear, restored row is visible with roughly `24..80` px above it
- `grid-occlusion`: mounted count is lower than total photo count

Use an explicit timeout budget for browser-backed tests. A 5-second default timeout is too easy to misread as a product failure.

## What To Validate

At the end, report:

- files created
- pure tests run
- browser checks run
- which `@fit` checks you added
- where the spec was still underspecified
- what you would change in the spec for the next worker

## Main-Thread Baseline

Current `demos/photo-gallery` contracts prove the important source-owned helper seams cleanly:

- `layout.ts` and `prompt-layout.ts`: 65 pass, 0 fail, 0 unknown
- all checked sibling demo contracts: 126 pass, 0 fail, 0 unknown

The useful ground-truth facts now include:

- grid image caps and width capping against natural width and box width
- prompt visible line count, visible height, inner max width, and prompt layout width
- line max sizes, previous/next target math, and stable edge hit boxes
- image/layout/occlusion/prompt geometry copied from the pure item helper

The wider product helpers are still beyond the current checker surface:

- `getGridLayout` inference still does not prove the whole row-height packing loop. That is okay; the direct helper contracts already cover the source-owned sizing and geometry that matter for this trial.
- `getLineLayout` inference stops at the reverse indexed loop that walks left from the focused item. Supporting that loop shape could help, but it is not required for the first useful helper contracts.
- `measurePromptLayout` inference stops at the `while (true)` rich-inline cursor loop. That is browser/text-engine-adjacent enough that the first facts should stay on the smaller visible-line-count helpers.

The first version of this packet accidentally asked for `result.left.targetIndex` on a helper where the left hit area can be null at `focused = 0`. Splitting target-index math from nullable edge control flow made the source-owned contract honest. This is the kind of spec bug I want Freerange to surface early.

## Fresh-Agent Results

Two fresh workers rebuilt the demo in disjoint Vibescript scratch folders from this packet and the Vibescript docs only:

- `/Users/chenglou/github/vibescript/drafts/demos_with_specs/photo-gallery/freerange-round-a`
- `/Users/chenglou/github/vibescript/drafts/demos_with_specs/photo-gallery/freerange-round-b`

Both produced:

- a runnable grid/line photo gallery
- pure helper tests
- page-owned browser reports for hash sync, caption selection, dismiss-to-row, and occlusion
- Freerange `@fit` comments on the same five helper seams

Main-thread reruns:

```txt
round A:
  bun test                                  -> 5 pass
  bun run verify geometry.ts               -> 18 pass, 0 fail, 0 unknown
  bun run browser-checks.ts                -> 4 scenario reports ready

round B:
  bun test index.test.ts                   -> 5 pass
  bun run verify photo-gallery-helpers.ts  -> 18 pass, 0 fail, 0 unknown
  tsc over helpers + index                 -> pass
  bun browser-check.ts                     -> 4 scenario reports ready
```

This is better than the older photo-gallery trials. The agents did not need screenshots, did not invent Playwright config, and did not turn the runner into a second layout engine. Both kept the formal claims on boring source-owned helpers and left native selection, hash navigation, scroll restore, and occlusion to page-owned reports.

The scratch demos are still not faithful recreations of the current hand-written demo. They simplify or choose their own answers for line sizing, transition behavior, neighbor visibility, GitHub link target, and overscan. That is fine for this trial. It means Freerange improved the spec's executable skeleton, not the whole product taste layer.

## What Freerange Helped

The formal seam did two useful things:

- It made both workers converge on the same pure boundaries: grid columns, rect construction, previous/next target math, and stable line hit boxes.
- It caught a real spec bug early: nullable hit areas cannot honestly expose `result.left.targetIndex` for every focused index.

No new primitive was needed. Plain ranges, comparisons, constants, helper contracts, and source inference were enough for the useful checks.

The source checks also made the browser reports narrower. The workers did not need to prove line-strip geometry from a screenshot or from DOM scraping; the source helper owned that geometry, and the page report owned only the click outcome.

## What Stayed Prose

The repeated underspecified parts were:

- exact line-mode image sizing
- whether line mode renders all neighbors, clipped neighbors, or just a local window
- edge-strip behavior at the first and last item
- grid bottom runway for dismiss restore near the end of the list
- exact overscan budget for "visible or near-visible"
- GitHub link destination
- whether transitions are required, and if so which frame-level handoff facts matter

These are not all Freerange language gaps. Most are product/spec gaps. If we want the generated demo to match the current hand-written one, the packet needs to say those things.

## V2 Packet Deltas

For the next worker, add these concrete rules instead of relying on taste:

- Line mode:
  - `box1DMaxSizeY = windowSizeY - 40 - 28`
  - `box1DMaxSizeX = windowSizeX - 52 * 2 - 100 * 2`
  - focused item uses scale `1`
  - neighbors use scale `0.7`
  - cards are laid out on one horizontal cursor with `52` px gaps
  - image height uses the image aspect ratio and the chosen scaled width

- Edge strips:
  - left strip at index `0` no-ops
  - right strip at the last index no-ops
  - middle area dismisses only when neither edge strip applies

- Occlusion:
  - state one viewport for the browser check, e.g. `1280 x 720`
  - state a concrete overscan budget, e.g. mounted rows may include rows intersecting the viewport plus `160` px above/below
  - report both mounted count and total count

- Dismiss restore:
  - the page needs enough bottom scroll runway for low rows
  - restored row top should land in `24..80` px above the viewport

- Links and transitions:
  - name the GitHub URL if it matters
  - if transition fidelity matters, ask for one page-owned frame sample at `t=16ms`; otherwise say transitions are optional

That V2 still should not ask Freerange to prove browser-owned behavior. It should use Freerange for source geometry and page reports for opened-page semantics.
