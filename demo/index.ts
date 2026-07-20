import {photoGalleryData} from './data'

// === generic scheduler & its debugger
let scheduledRender = false
function scheduleRender(): void {
  if (scheduledRender) return;
  scheduledRender = true
  requestAnimationFrame(function renderAndMaybeScheduleAnotherRender(now) { // eye-grabbing name. No "(anonymous)" function in the debugger & profiler
    scheduledRender = false
    if (render(now)) scheduleRender()
  })
}

// === generic spring physics
// 4ms/step for the spring animation's step. Typically 4 steps for 60fps (16.6ms/frame) and 2 for 120fps (8.3ms/frame). Frame time delta varies, so not always true
// could use 8ms instead, but 120fps' 8.3ms/frame means the computation might not fit in the remaining 0.3ms, which means sometime the simulation step wouldn't even run once, giving the illusion of jank
const msPerAnimationStep = 4
type Spring = {
  pos: number
  dest: number
  v: number
  k: number // @fit > 0
  b: number // @fit > 0
}

function spring(
  pos: number,
  v = 0,
  k: number = 290, // @fit > 0
  b: number = 30, // @fit > 0
): Spring {
  return {pos, dest: pos, v, k, b} // k = stiffness, b = damping. Try https://chenglou.me/react-motion/demos/demo5-spring-parameters-chooser/
}
function springStep(config: Spring): Spring {
  // https://blog.maximeheckel.com/posts/the-physics-behind-spring-animations/
  // this seems inspired by https://github.com/chenglou/react-motion/blob/9e3ce95bacaa9a1b259f969870a21c727232cc68/src/stepper.js
  // convert to seconds for the physics equation
  const t = msPerAnimationStep / 1000
  const {pos, dest, v, k, b} = config
  // for animations, dest is actually spring at rest. Current position is the spring's stretched/compressed state
  const Fspring = -k * (pos - dest) // Spring stiffness, in kg / s^2
  const Fdamper = -b * v // Damping, in kg / s
  const a = Fspring + Fdamper // a needs to be divided by mass, but we'll assume mass of 1. Adjust k and b to change spring curve instead
  const newV = v + a * t
  const newPos = pos + newV * t

  return {pos: newPos, dest, v: newV, k, b}
}
function springGoToEnd(config: Spring): Spring {
  return {pos: config.dest, dest: config.dest, v: 0, k: config.k, b: config.b}
}

// === generic helpers
/** @fit
 * given max >= min
 * return >= min
 * return <= max
 */
function clamp(
  min: number,
  v: number,
  max: number,
): number {
  return v > max ? max : v < min ? min : v
}

// === constant layout metrics. The rest is dynamic
const promptPaddingBottom = 8
const promptSizeY = 44 + promptPaddingBottom // 44 is a magic number. Doesn't show the 3rd line nor cuts the 2nd line on safari, mobile safari and chrome
const prompt1DSizeY = 64 + promptPaddingBottom // size in 1d mode
const boxesGapX = 24, boxesGapY = 24
const boxes1DGapX = 52, boxes1DGapY = 28
const windowPaddingTop = 40
const gapTopPeek = 40 // used when programmatically scrolling and wanting to show some gap at the top of a row
const hitArea1DSizeX = 100 // left and right click region in 1D mode

/** @fit
 * given containerSizeX: int 0..<Infinity
 * return.cols: int 1..7
 * return.boxMaxSizeX > 0
 */
function colsBoxMaxSizeXF(containerSizeX: number): {cols: number; boxMaxSizeX: number} {
  const boxMinSizeX = 220 // Make sure that on mobile, this min width is big enough not to show 2 images per row. Also, this won't be respected if view's tiny
  const cols = clamp(1, Math.floor((containerSizeX - boxesGapX) / (boxMinSizeX + boxesGapX)), 7) // half of boxesGapX for container's left and right gap
  const boxMaxSizeX = Math.max(1, (containerSizeX - boxesGapX - cols * boxesGapX) / cols)
  return {
    cols,
    boxMaxSizeX,
  }
}

const isSafari = navigator.userAgent.includes('Safari') && !navigator.userAgent.includes('Chrome') // Chrome also includes Safari in user-agent string
if (isSafari) {
  // alright *deep breath* Desktop Safari is fine, but iPad Safari behaves badly when items exceed the viewport in 1D mode (overflow hidden doesn't work!). This is prominent if you hold arrow right and check the GitHub logo move. It's especially pathological on Stage Manager and any other iPad Safari mode where the app window shrinks and bugs the browser more for whatever reason
  // so we use contain: layout plus viewport width and height to force the clipping of items. Now every browser behaves well with these, BUT Chrome doesn't have rubberbanding of inner elements (only page-wide one). So YES I'm switching to scrolling page instead of document body for Chrome JUST FOR THE RUBBER BANDING on macOS.
  // this is how much I care about edge scroll rubber banding. Thanks Bas Ording & old Apple. If browser specs folks were more visual & interactions-driven as opposed to being static document-driven then we wouldn't have a decade-long decline of visual & interaction design as a discipline.
  // it's a good thing these hacks are easy to pull off under this architecture, and quite readable and even robust despite changing whole container logics
  document.body.style.contain = 'layout'
  document.body.style.width = '100vw'
  document.body.style.height = '100vh'
}

// === state. Plus one in the URL's hash
let debug = false // toggle this for manually stepping through animation frames (press key A)
function isDebug(): boolean {
  return debug
}
let debugTimestamp = 0
let animatedUntilTime: number | null = null
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
let anchor = 0 // keep a box stable during resize layout shifts
let windowSizeX = document.documentElement.clientWidth
let scrollY = isSafari ? document.body.scrollTop : window.scrollY
let pointer: {x: number; y: number} = {x: -Infinity, y: -Infinity} // btw, on page load, there's no way to render a first cursor state =(
let events: {keydown: KeyboardEvent | null; click: MouseEvent | null; mousemove: MouseEvent | null} = {keydown: null, click: null, mousemove: null}
type BoxData = {
  id: string
  naturalSizeX: number // @fit int 1..Infinity
  ar: number // @fit > 0
  sizeX: Spring // @fit sizeX.dest > 0
  sizeY: Spring // @fit sizeY.dest > 0
  x: Spring
  y: Spring
  scale: Spring // @fit scale.dest: 1..1.02
  fxFactor: Spring
  node: HTMLDivElement
  img: HTMLImageElement
  promptNode: HTMLElement
}

let data: BoxData[] = (() => {
  const windowSizeY = document.documentElement.clientHeight
  const {cols, boxMaxSizeX} = colsBoxMaxSizeXF(windowSizeX)
  const imgMaxSizeY = boxMaxSizeX + 100 // TODO: adjust this better
  return photoGalleryData.map((d, i) => {
    const ar = d.w / d.h
    const sizeX = Math.min(d.w, boxMaxSizeX, imgMaxSizeY * ar)
    const sizeY = sizeX / ar + promptSizeY
    // upon zooming into 1D mode (big image), swapping out an img src for a higher-res one would cause a flash of blank image in certain cases. Instead, we put the low-res image as a background-image on the container, then the high-res image as a real img on top. Hand-rolled double buffering...
    const node = document.createElement('div')
        node.className = 'box'
        // node.tabIndex = i + 1 // uncomment when dismiss focus isn't this ugly blue hue anymore
        node.style.backgroundImage = `url(https://cdn.midjourney.com/${d.id}_384_N.webp)` // 128 is the next smallest. Too small for retina screens
    const img = document.createElement('img')
        // img.decoding = 'async' // this sucks. It's slower _and_ still janks the UI. No point
    const promptNode = document.createElement('figcaption')
        promptNode.className = 'prompt'
        promptNode.textContent = d.prompt
    node.append(img, promptNode)
    return {
      id: d.id,
      naturalSizeX: d.w,
      ar, // aspect ratio
      sizeX: spring(sizeX),
      sizeY: spring(sizeY), // image + prompt
      x: spring(Math.floor(i / cols) * -windowSizeX - windowSizeX), // unfold from lower left. More visible on long screens
      y: spring(windowSizeY + Math.floor(i / cols) * imgMaxSizeY),
      scale: spring(1),
      fxFactor: spring(20), // for brightness and blur
      node,
      img,
      promptNode,
    }
  })
})()
function springForEach(f: (s: Spring) => Spring): void { // no spring ownership struggle between the spring library above vs consumer; un-inversion of control!
  data = data.map(d => ({...d, sizeX: f(d.sizeX), sizeY: f(d.sizeY), x: f(d.x), y: f(d.y), scale: f(d.scale), fxFactor: f(d.fxFactor)})) // no different than [a, b, c].map(f)
}
function stepSprings(steps: number): boolean {
  let stillAnimating = false
  data = data.map(d => {
    const sizeX = stepSpring(d.sizeX, steps)
    const sizeY = stepSpring(d.sizeY, steps)
    const x = stepSpring(d.x, steps)
    const y = stepSpring(d.y, steps)
    const scale = stepSpring(d.scale, steps)
    const fxFactor = stepSpring(d.fxFactor, steps)
    if (springStillAnimating(sizeX) || springStillAnimating(sizeY) || springStillAnimating(x) || springStillAnimating(y) || springStillAnimating(scale) || springStillAnimating(fxFactor)) stillAnimating = true
    return {...d, sizeX, sizeY, x, y, scale, fxFactor}
  })
  return stillAnimating
}
function springStillAnimating(s: Spring): boolean {
  return Math.abs(s.v) >= 0.01 || Math.abs(s.dest - s.pos) >= 0.01
}
function stepSpring(
  s: Spring,
  steps: number, // @fit int 0..Infinity
): Spring {
  let stepped = s
  for (let i = 0; i < steps; i++) {
    const next = springStep(stepped)
    if (!Number.isFinite(next.pos) || !Number.isFinite(next.v)) return springGoToEnd(s)
    stepped = next
  }
  return springStillAnimating(stepped) ? stepped : springGoToEnd(stepped) // close enough? Snap to done
}

// === events
// pointermove doesn't work on android, pointerdown isn't fired on Safari on the first left click after dismissing context menus, mousedown doesn't trigger properly on mobile, pointerup isn't triggered when pointer panned (at least on iOS), don't forget contextmenu event. Tldr there's no pointer event that works cross-browser that can replace mouse & touch events.
window.addEventListener('resize', () => scheduleRender())
window.addEventListener('scroll', () => scheduleRender(), true) // capture is needed for iPad Safari...
window.addEventListener('popstate', () => scheduleRender())
window.addEventListener('keydown', (e) => {events.keydown = e; scheduleRender()})
window.addEventListener('click', (e) => {events.click = e; scheduleRender()})
window.addEventListener('mousemove', (e) => {events.mousemove = e; scheduleRender()})

// === static DOM initialization. Just 1 in this app. The more you have here the more your app looks like a PDF document. Minimize
const dummyPlaceholder = document.createElement('div')
dummyPlaceholder.style.position = 'absolute'
dummyPlaceholder.style.width = '1px' // make it tiny in case it affects compositing... sigh lamport.azurewebsites.net/pubs/future-of-computing.pdf
document.body.append(dummyPlaceholder)
if (isDebug()) {
  document.documentElement.style.background = 'repeating-linear-gradient(#e66465 0px, #9198e5 300px)'
  document.documentElement.style.height = '100%'
}

// === hit testing logic. Boxes' hit area should be static and not follow their current animated state usually (but we can do either)
function hitTest2DMode(data: BoxData[], pointerX: number, pointerY: number): number | null {
  for (let i = 0; i < data.length; i++) {
    let {x, y, sizeX, sizeY} = data[i]!
    if (x.dest <= pointerX && pointerX < x.dest + sizeX.dest && y.dest <= pointerY && pointerY < y.dest + sizeY.dest) return i // pointer on this box
  }
  return null
}
function hitTest1DMode(data: BoxData[], focused: number, windowSizeX: number, pointerX: number): number | null {
  // allow spamming clicks without accidentally clicking on an empty region on left/right side or newly focused image during transition (and dismiss 1D mode)
  return focused > 0 && 0 <= pointerX /* might be -Infinity */ && pointerX <= hitArea1DSizeX ? Math.max(0, focused - 1) // left
    : focused < data.length - 1 && pointerX >= windowSizeX - hitArea1DSizeX ? Math.min(data.length - 1, focused + 1) // right
    : null
}

function render(now: number): boolean {
  // === step 0: process events
  // keydown
  const inputCode = events.keydown == null ? null : events.keydown.code

  // click
  let clickedTarget: EventTarget | null = null
  if (events.click != null) {
    // needed to update coords even when we already track mousemove. E.g. in Chrome, right click context menu, move elsewhere, then click to dismiss. BAM, mousemove triggers with stale/wrong (??) coordinates... Click again without moving, and now you're clicking on the wrong thing
    clickedTarget = events.click.target
    pointer = {x: events.click.clientX, y: events.click.clientY}
  }
  // mousemove
  if (events.mousemove != null) {
    // we only use clientX/Y, not pageX/Y, because we want to ignore scrolling. See comment around isSafari above; we either scroll body or window depending on the browser, so pageX/Y might be meaningless (if Safari)
    pointer = {x: events.mousemove.clientX, y: events.mousemove.clientY}
    // btw, pointer can exceed document bounds, e.g. dragging reports back out-of-bound, legal negative values
  }

  if (debug) {
    if (inputCode === 'KeyA') debugTimestamp += 1000 / 60
    now = debugTimestamp
  }

  // === step 1: batched DOM reads (to avoid accidental DOM read & write interleaving)
  const newWindowSizeX = document.documentElement.clientWidth // excludes scroll bar & invariant under safari pinch zoom
  const windowSizeY = document.documentElement.clientHeight // same
  // this way, when pinch zooming in, we don't occlude away rows outside of the view; if we did, when we zoom out again we wouldn't see those occluded rows until we release our fingers. During safari pinch, no event is triggered so we couldn't have updated the occlusion in real time
  const animationDisabled = reducedMotion.matches
  const currentScrollY = isSafari ? document.body.scrollTop : window.scrollY
  const currentScrollX = isSafari ? document.body.scrollLeft : window.scrollX
  const hashImgId = window.location.hash.slice(1)

  let focused: number | null = null; for (let i = 0; i < data.length; i++) if (data[i]!.id === hashImgId) focused = i
  // don't forget top & bottom safari UI chrome sizes when vertically occluding, since they're transluscent so we can't over-occlude by ignoring them
  const pointerXLocal = pointer.x +/*toLocal*/currentScrollX, pointerYLocal = pointer.y +/*toLocal*/currentScrollY

  // === step 2: handle inputs-related state change
  // keys
  let newFocused =
    inputCode === 'Escape' ? null
    : (inputCode === 'ArrowLeft' || inputCode === 'ArrowRight') && focused == null ? 0
    : inputCode === 'ArrowLeft' ? Math.max(0, focused! - 1)
    : inputCode === 'ArrowRight' ? Math.min(data.length - 1, focused! + 1)
    : focused
  // pointer
  if (clickedTarget != null) { // clicked
    if (clickedTarget instanceof HTMLElement && clickedTarget.tagName === 'FIGCAPTION') { // select the whole prompt
      const selection = window.getSelection()
      if (selection == null) throw new Error('Expected document selection API')
      const range = document.createRange()
      range.selectNodeContents(clickedTarget)
      selection.removeAllRanges()
      selection.addRange(range)
    } else if (focused == null) { // in 2D grid mode. Find the box the pointer's on
      newFocused = hitTest2DMode(data, pointerXLocal, pointerYLocal) ?? newFocused
    } else { // 1D mode
      newFocused = hitTest1DMode(data, focused, newWindowSizeX, pointerXLocal)
    }
  }

  // === step 3: calculate new layout & cursor
  const {cols, boxMaxSizeX} = colsBoxMaxSizeXF(newWindowSizeX)
  const boxes2DSizeX: number[] = [], boxes2DSizeY: number[] = [], rowsTop: number[] = [windowPaddingTop] // length: number of rows + 1
  { // first pass over data to set final 2D dimensions and row height (for vertical centering in 2D & total scrollbar height)
    let rowMaxSizeY = 0
    for (let i = 0; i < data.length; i++) {
      let d = data[i]!
      const imgMaxSizeY =
        d.ar === 1 ? boxMaxSizeX * 0.85 // square aspect ratio area too big. Shrink it
        : d.ar < 1 ? boxMaxSizeX * 1.05 // vertical images look a bit small. Grow it
        : boxMaxSizeX
      const sizeX = Math.min(d.naturalSizeX, boxMaxSizeX, imgMaxSizeY * d.ar)
      const sizeY = sizeX / d.ar + promptSizeY
      boxes2DSizeX.push(sizeX)
      boxes2DSizeY.push(sizeY)
      rowMaxSizeY = Math.max(rowMaxSizeY, sizeY)
      if (i % cols === cols - 1 || i === data.length - 1) { // last box of the row or last box ever
        rowsTop.push(rowsTop.at(-1)! + rowMaxSizeY + boxesGapY)
        rowMaxSizeY = 0
      }
    }
  }
  let cursor = 'auto'
  let newAnchor = anchor
  let adjustedScrollTop = currentScrollY
  const hoverMagnetFactor = 40
  if (newFocused == null) { // 2D mode
    if (focused != null) { // just dismissed 1D mode
      const focusedTop = rowsTop[Math.floor(focused / cols)]!
      // if the dismissed box isn't fully shown, scroll to it (later after the render code block)
      if (focusedTop <= currentScrollY || focusedTop + boxes2DSizeY[focused]! >= currentScrollY + windowSizeY) {
        adjustedScrollTop = focusedTop - boxesGapY - gapTopPeek // Peek a little higher to show the previous row
      }
    }

    for (let i = 0; i < data.length; i++) { // calculate boxes positions
      let d = data[i]!
      const sizeX = boxes2DSizeX[i]!, sizeY = boxes2DSizeY[i]!
      const currentRow = Math.floor(i / cols)
      const rowMaxSizeY = rowsTop[currentRow + 1]! - boxesGapY - rowsTop[currentRow]! // this is restoring the rowMaxSizeY info above, kinda weird
      d.sizeX.dest = sizeX
      d.sizeY.dest = sizeY
      d.x.dest = boxesGapX + (boxMaxSizeX + boxesGapX) * (i % cols) + (boxMaxSizeX - sizeX) / 2 // center horizontally
      d.y.dest = rowsTop[currentRow]! + (rowMaxSizeY - sizeY) / 2
      d.scale.dest = 1
      d.fxFactor.dest = 1
    }

    const hit = hitTest2DMode(data, pointerXLocal, pointerYLocal)
    if (hit == null) cursor = 'auto'
    else { // hovering over a box. Adjust position
      cursor = 'zoom-in'
      let {x, y, sizeX, sizeY, scale} = data[hit]!
      x.dest += (pointerXLocal - (x.dest + sizeX.dest / 2)) / hoverMagnetFactor
      y.dest += (pointerYLocal - (y.dest + sizeY.dest / 2)) / hoverMagnetFactor
      scale.dest = 1.02
    }
    // if layout shifted, keep the boxes near the same place to prevent annoying layout jumps while viewing
    const anchorY = data[anchor]!.y.dest - gapTopPeek
    if (newWindowSizeX !== windowSizeX) adjustedScrollTop = Math.max(0, anchorY) // resized; maintain position!
    if (adjustedScrollTop !== scrollY && Math.abs(anchorY -/*toLocal*/adjustedScrollTop) > windowSizeY / 10) { // find new anchor if the current one moved too much
      for (newAnchor = 0; newAnchor < data.length; newAnchor += cols) { // new anchor is picked from leftmost column. Btw old anchor might not be from leftmost col due to resize layout shifts
        let d = data[newAnchor]!
        // find 1st box whose bottom exceeds 20% of window height
        if (d.y.dest + d.sizeY.dest -/*toLocal*/adjustedScrollTop > windowSizeY / 5) break
      }
    }
  } else { // 1D mode
    const img1DSizeY = Math.max(1, windowSizeY - windowPaddingTop - prompt1DSizeY - boxes1DGapY)
    const box1DMaxSizeX = Math.max(1, newWindowSizeX - boxes1DGapX * 2 - hitArea1DSizeX * 2)

    let currentLeft = hitArea1DSizeX + boxes1DGapX // start from the right edge of the left box and...
    for (let i = newFocused - 1; i >= 0; i--) { // ...iterate til we get the left edge of the very first box
      let d = data[i]!
      const imgSizeX = Math.min(d.naturalSizeX, box1DMaxSizeX, img1DSizeY * d.ar) * 0.7
      currentLeft -= imgSizeX + boxes1DGapX
    }

    const edgeRubberBandVelocityX = // feedback when you hit first/last image and keep pressing left/right key
      inputCode === 'ArrowLeft' && focused === 0 ? 2 * 1000 // 2 pixels per second
      : inputCode === 'ArrowRight' && focused === data.length - 1 ? -2 * 1000
      : 0
    for (let i = 0; i < data.length; i++) { // calculate boxes positions
      let d = data[i]!
      const imgSizeX = Math.min(d.naturalSizeX, box1DMaxSizeX, img1DSizeY * d.ar) * (i === newFocused ? 1 : 0.7)
      const boxSizeY = imgSizeX / d.ar + prompt1DSizeY
      d.sizeX.dest = imgSizeX
      d.sizeY.dest = boxSizeY
      d.y.dest = Math.max(windowPaddingTop, (windowSizeY - boxSizeY) / 2) +/*toLocal*/adjustedScrollTop
      d.x.dest = i === newFocused ? (newWindowSizeX - imgSizeX) / 2 : currentLeft
      d.x.v += edgeRubberBandVelocityX / (i === newFocused ? 1 : 4)
      d.scale.dest = 1
      d.fxFactor.dest = i === newFocused ? 1 : 0.2 // center image has no brightness & blur effect

      currentLeft = i === newFocused ? newWindowSizeX - hitArea1DSizeX : currentLeft + imgSizeX + boxes1DGapX
    }

    const hit = hitTest1DMode(data, newFocused, newWindowSizeX, pointerXLocal)
    if (hit == null) cursor = 'zoom-out'
    else { // hovering on left or right image
      cursor = 'zoom-in'
      let {x, y, sizeX, sizeY, scale, fxFactor} = data[hit]!
      x.dest += (pointerXLocal - (x.dest + sizeX.dest / 2)) / hoverMagnetFactor
      y.dest += (pointerYLocal - (y.dest + sizeY.dest / 2)) / hoverMagnetFactor
      scale.dest = 1.02
      fxFactor.dest = 0.5
    }
  }
  // ensure that no matter how the scrolling is abruptly adjusted, the boxes on the screen don't suddenly jump too. When going 1D->2D mode where the dismissed image might be far from the initial one, or when resizing causes layout shifts, the boxes now stay unaffected!
  for (let {y} of data) y.pos += adjustedScrollTop - currentScrollY

  // === step 4: run animation
  let newAnimatedUntilTime = animatedUntilTime ?? now
  const steps = Math.floor((now - newAnimatedUntilTime) / msPerAnimationStep) // run x spring steps. Decouple physics simulation from framerate!
  newAnimatedUntilTime += steps * msPerAnimationStep
  const stillAnimating = animationDisabled ? false : stepSprings(steps)
  if (animationDisabled) springForEach(springGoToEnd)

  // === step 5: render. Batch DOM writes
  const browserUIMaxSizeTop = 100, browserUIMaxSizeBottom = 150 // browsers UI like Safari are transluscent. Random conservative numbers
  for (let i = 0; i < data.length; i++) {
    let d = data[i]!
    const {node, img, promptNode} = d
    if ( // occlusion culling, aka only draw what's visible on screen (aka "virtualization")
      d.y.pos -/*toGlobal*/adjustedScrollTop <= windowSizeY + browserUIMaxSizeBottom &&
      d.y.pos + d.sizeY.pos -/*toGlobal*/adjustedScrollTop >= -browserUIMaxSizeTop &&
      d.x.pos <= newWindowSizeX &&
      d.x.pos + d.sizeX.pos >= 0
    ) { // disregard shadow & scaling for now; browserUIMaxSizeBottom and browserUIMaxSizeTop are safe bigger values anyway
      node.style.width = `${d.sizeX.pos}px`
      node.style.height = `${d.sizeY.pos}px`
      node.style.transform = `translate3d(${d.x.pos}px,${d.y.pos}px,0) scale(${d.scale.pos})` // safari now anti-aliases for hover, but then zoom in janks on big displays...
      // we can't afford fxFactor & blur for all pics; too expensive for Safari & Chrome. E.g. when zomming out of a photo, keep scrolling; Chrome stops render on Studio Display
      node.style.filter = newFocused != null && (i === newFocused - 1 || i === newFocused || i === newFocused + 1)
        ? `brightness(${d.fxFactor.pos * 100}%) blur(${Math.max(0, 6 - d.fxFactor.pos * 6)}px)` // blur these 3 only
        : `brightness(${d.fxFactor.pos * 100}%)` // blur of unrelated pics is too fast during transition from/to 1D mode to be seen anyway
      if (debug) node.style.outline = i === newAnchor ? '2px solid rgba(255, 255, 0, 0.8)' : 'none'
      promptNode.style.top = `${d.sizeX.pos / d.ar}px` // right below img's sizeY

      if (i === newFocused) {
        node.style.zIndex = `${data.length + 1}` // guaranteed above everything
        promptNode.style.overflowY = 'auto'
        promptNode.style.height = `${prompt1DSizeY - promptPaddingBottom}px`
        promptNode.style.setProperty('line-clamp', '999')
        promptNode.style.webkitLineClamp = '999'
        img.style.display = 'block'
        let src = `https://cdn.midjourney.com/${d.id}.webp`
        if (!stillAnimating && img.src !== src) img.src = src // load the full res image
      } else {
        node.style.zIndex = `${i + 1}` // simple proper z-index management
        promptNode.style.overflowY = 'hidden'
        promptNode.style.height = `${promptSizeY - promptPaddingBottom}px`
        promptNode.style.setProperty('line-clamp', '2')
        promptNode.style.webkitLineClamp = '2'
        img.style.display = 'none' // hide full res image for perf (yes it makes a difference, even on M1, with Studio Display)
      }
      if (node.parentNode == null) document.body.appendChild(node) // if previously absent, add
    } else if (node.parentNode != null) document.body.removeChild(node) // if previously present, remove
  }

  document.body.style.cursor = cursor
  document.body.style.overflowY = newFocused == null ? 'auto' : 'hidden'
  dummyPlaceholder.style.height = `${rowsTop.at(-1)!}px` // Chrome has race conditon if scrollTo is called before setting a longer dummy height

  // === step 6: update state & prepare for next frame
  // if (adjustedScrollTop !== currentScrollTop) window.scrollTo({top: adjustedScrollTop}) // will trigger scrolling, thus next frame's render
  if (adjustedScrollTop !== currentScrollY) {
    // see comment about isSafari above
    (isSafari ? document.body : window).scrollTo({top: adjustedScrollTop}) // will trigger scrolling, thus next frame's render
  }
  if (newFocused !== focused) {
    window.history.pushState(null, '', `${window.location.pathname}${window.location.search}${newFocused == null ? '' : '#' + data[newFocused]!.id}`)
  }
  events.keydown = null
  events.click = null
  events.mousemove = null
  animatedUntilTime = stillAnimating ? newAnimatedUntilTime : null
  anchor = newAnchor
  windowSizeX = newWindowSizeX
  scrollY = adjustedScrollTop

  return stillAnimating
}

scheduleRender()
