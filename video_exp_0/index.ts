const minimumViewportWidth = 360
const minimumViewportHeight = 390
const maximumViewportWidth = 7_680
const maximumViewportHeight = 4_320
const toolbarHeight = 60
const videoAspectRatio = 16 / 9
const mediaDuration = 90

type Rectangle = {
  x: number
  y: number
  width: number
  height: number
}

type FrameMetrics = {
  viewportWidth: number
  viewportHeight: number
  outerInset: number
  verticalGap: number
  toolbarHeight: number
  toolbar: Rectangle
  stage: Rectangle
  timeline: Rectangle
  timelineTrackInset: number
  timelineTrack: Rectangle
}

type VideoMetrics = {
  width: number
  height: number
  horizontalTravel: number
  verticalTravel: number
  offsetX: number
  offsetY: number
}

type CropMetrics = {
  x: number
  y: number
  width: number
  height: number
  minimumWidth: number
  minimumHeight: number
  maximumX: number
  maximumY: number
  normalizedX: number
  normalizedY: number
  normalizedWidth: number
  normalizedHeight: number
}

type TimelineMetrics = {
  duration: number
  minimumClipDuration: number
  maximumStart: number
  start: number
  minimumEnd: number
  end: number
  playhead: number
  startX: number
  endX: number
  playheadX: number
  clipWidth: number
}

type MenuMetrics = {
  inset: number
  width: number
  height: number
  panelGap: number
  panelX: number
  panelY: number
  panelWidth: number
  panelHeight: number
  launcherSize: number
  horizontalTravel: number
  verticalTravel: number
  x: number
  y: number
  launcherX: number
  launcherY: number
}

type Corner = 'topLeft' | 'topRight' | 'bottomRight' | 'bottomLeft'
type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

type CropHandleRectangles = {
  nw: Rectangle
  n: Rectangle
  ne: Rectangle
  e: Rectangle
  se: Rectangle
  s: Rectangle
  sw: Rectangle
  w: Rectangle
}

type CropRequest = {
  x: number
  y: number
  width: number
  height: number
}

type MenuTargetRectangles = {
  topLeft: Rectangle
  topRight: Rectangle
  bottomRight: Rectangle
  bottomLeft: Rectangle
}

type PointerIdentity = {
  source: InputSource
  id: number
}

type Drag =
  | {kind: 'cropMove'; pointer: PointerIdentity; offsetX: number; offsetY: number}
  | {
    kind: 'cropResize'
    pointer: PointerIdentity
    handle: ResizeHandle
    anchorX: number
    anchorY: number
    grabOffsetX: number
    grabOffsetY: number
  }
  | {kind: 'trimStart'; pointer: PointerIdentity; fixedEnd: number; grabOffsetX: number}
  | {kind: 'trimEnd'; pointer: PointerIdentity; fixedStart: number; grabOffsetX: number}
  | {kind: 'playhead'; pointer: PointerIdentity; grabOffsetX: number}
  | {
    kind: 'menu'
    pointer: PointerIdentity
    offsetX: number
    offsetY: number
    startX: number
    startY: number
    currentX: number
    currentY: number
    moved: boolean
  }

type InputSource = 'mouse' | 'touch'
type InputPhase = 'down' | 'move' | 'up' | 'cancel'

type PointerInput = {
  kind: 'pointer'
  source: InputSource
  phase: InputPhase
  pointerId: number
  pageX: number
  pageY: number
  clientX: number
  clientY: number
  button: number
  timeStamp: number
}

type KeyInput = {
  kind: 'key'
  code: string
  shiftKey: boolean
  repeat: boolean
  targetId: string
  targetHandle: string
  timeStamp: number
}

type GlobalCancelInput = {
  kind: 'globalCancel'
  reason: 'blur' | 'contextmenu'
  timeStamp: number
}

type EditorInput = PointerInput | KeyInput | GlobalCancelInput

type EditorState = {
  cropX: number
  cropY: number
  cropWidth: number
  cropHeight: number
  trimStart: number
  trimEnd: number
  playhead: number
  menuCorner: Corner
  menuExpanded: boolean
  layoutInitialized: boolean
  drag: Drag | null
  pointerClientX: number
  pointerClientY: number
  latestTouchTime: number | null
  events: EditorInput[]
}

type PageLayout = {
  frame: FrameMetrics
  videoMetrics: VideoMetrics
  cropMetrics: CropMetrics
  timelineMetrics: TimelineMetrics
  menuMetrics: MenuMetrics
  videoInStage: Rectangle
  videoOnPage: Rectangle
  cropInVideo: Rectangle
  cropFormulaInVideo: Rectangle
  cropOnPage: Rectangle
  cropHandlesOnPage: CropHandleRectangles
  timelineTrackOnPage: Rectangle
  clipInTrack: Rectangle
  clipOnPage: Rectangle
  trimStartOnPage: Rectangle
  trimEndOnPage: Rectangle
  playheadInTrack: Rectangle
  playheadOnPage: Rectangle
  menuInStage: Rectangle
  menuPanelInRoot: Rectangle
  menuLauncherInRoot: Rectangle
  menuLauncherOnPage: Rectangle
  menuTargetsInStage: MenuTargetRectangles
}

function calculateFrameMetrics(viewportWidth: number, viewportHeight: number): FrameMetrics {
  console.assert(Number.isInteger(viewportWidth))
  console.assert(viewportWidth >= minimumViewportWidth)
  console.assert(viewportWidth <= maximumViewportWidth)
  console.assert(Number.isInteger(viewportHeight))
  console.assert(viewportHeight >= minimumViewportHeight)
  console.assert(viewportHeight <= maximumViewportHeight)

  const outerInset = Math.min(28, Math.max(16, viewportWidth * 0.018))
  const verticalGap = Math.min(20, Math.max(12, viewportHeight * 0.018))
  const timelineHeight = Math.min(168, Math.max(108, viewportHeight * 0.18))
  const stageWidth = Math.max(1, viewportWidth - outerInset * 2)
  const toolbarY = outerInset
  const stageY = toolbarY + toolbarHeight + verticalGap
  const timelineY = Math.max(0, viewportHeight - outerInset - timelineHeight)
  const stageBottom = Math.max(stageY + 1, timelineY - verticalGap)
  const stageHeight = Math.max(1, stageBottom - stageY)
  const timelineTrackInset = Math.min(22, Math.max(14, viewportWidth * 0.014))
  const timelineTrackWidth = Math.max(1, stageWidth - timelineTrackInset * 2)
  const timelineTrackHeight = Math.max(44, timelineHeight - 60)

  console.assert(outerInset >= 16)
  console.assert(outerInset <= 28)
  console.assert(verticalGap >= 12)
  console.assert(verticalGap <= 20)
  console.assert(timelineHeight >= 108)
  console.assert(timelineHeight <= 168)
  console.assert(stageWidth >= 1)
  console.assert(stageHeight >= 1)
  console.assert(timelineY >= 0)
  console.assert(timelineTrackInset >= 14)
  console.assert(timelineTrackInset <= 22)
  console.assert(timelineTrackWidth >= 1)
  console.assert(timelineTrackHeight >= 44)

  return {
    viewportWidth,
    viewportHeight,
    outerInset,
    verticalGap,
    toolbarHeight,
    toolbar: {x: outerInset, y: toolbarY, width: stageWidth, height: toolbarHeight},
    stage: {x: outerInset, y: stageY, width: stageWidth, height: stageHeight},
    timeline: {x: outerInset, y: timelineY, width: stageWidth, height: timelineHeight},
    timelineTrackInset,
    timelineTrack: {
      x: timelineTrackInset,
      y: 48,
      width: timelineTrackWidth,
      height: timelineTrackHeight,
    },
  }
}

function calculateVideoMetrics(stageWidth: number, stageHeight: number): VideoMetrics {
  console.assert(stageWidth >= 1)
  console.assert(stageWidth <= maximumViewportWidth)
  console.assert(stageHeight >= 1)
  console.assert(stageHeight <= maximumViewportHeight)

  const widthAtStageHeight = stageHeight * videoAspectRatio
  const width = Math.min(stageWidth, Math.max(0, widthAtStageHeight))
  const heightAtVideoWidth = width / videoAspectRatio
  const height = Math.min(stageHeight, Math.max(0, heightAtVideoWidth))
  const horizontalTravel = Math.max(0, stageWidth - width)
  const verticalTravel = Math.max(0, stageHeight - height)
  const offsetX = Math.min(horizontalTravel, Math.max(0, horizontalTravel / 2))
  const offsetY = Math.min(verticalTravel, Math.max(0, verticalTravel / 2))

  console.assert(width >= 0)
  console.assert(width <= stageWidth)
  console.assert(height >= 0)
  console.assert(height <= stageHeight)
  console.assert(horizontalTravel >= 0)
  console.assert(verticalTravel >= 0)
  console.assert(offsetX >= 0)
  console.assert(offsetX <= horizontalTravel)
  console.assert(offsetY >= 0)
  console.assert(offsetY <= verticalTravel)

  return {width, height, horizontalTravel, verticalTravel, offsetX, offsetY}
}

function calculateCropMetrics(
  videoWidth: number,
  videoHeight: number,
  handleSize: number,
  requestedX: number,
  requestedY: number,
  requestedWidth: number,
  requestedHeight: number,
): CropMetrics {
  console.assert(videoWidth >= 1)
  console.assert(videoWidth <= maximumViewportWidth)
  console.assert(videoHeight >= 1)
  console.assert(videoHeight <= maximumViewportHeight)
  console.assert(handleSize >= 8)
  console.assert(handleSize <= 24)

  const minimumWidth = Math.min(videoWidth, Math.max(handleSize * 4, videoWidth * 0.18))
  const minimumHeight = Math.min(videoHeight, Math.max(handleSize * 4, videoHeight * 0.18))
  const requestedPixelWidth = requestedWidth * videoWidth
  const requestedPixelHeight = requestedHeight * videoHeight
  const width = Math.min(videoWidth, Math.max(minimumWidth, requestedPixelWidth))
  const height = Math.min(videoHeight, Math.max(minimumHeight, requestedPixelHeight))
  const maximumX = Math.max(0, videoWidth - width)
  const maximumY = Math.max(0, videoHeight - height)
  const requestedPixelX = requestedX * videoWidth
  const requestedPixelY = requestedY * videoHeight
  const x = Math.min(maximumX, Math.max(0, requestedPixelX))
  const y = Math.min(maximumY, Math.max(0, requestedPixelY))
  const normalizedX = Math.min(1, Math.max(0, x / videoWidth))
  const normalizedY = Math.min(1, Math.max(0, y / videoHeight))
  const normalizedWidth = Math.min(1, Math.max(0, width / videoWidth))
  const normalizedHeight = Math.min(1, Math.max(0, height / videoHeight))

  console.assert(minimumWidth >= 0)
  console.assert(minimumWidth <= videoWidth)
  console.assert(minimumHeight >= 0)
  console.assert(minimumHeight <= videoHeight)
  console.assert(width >= minimumWidth)
  console.assert(width <= videoWidth)
  console.assert(height >= minimumHeight)
  console.assert(height <= videoHeight)
  console.assert(maximumX >= 0)
  console.assert(maximumY >= 0)
  console.assert(x >= 0)
  console.assert(x <= maximumX)
  console.assert(y >= 0)
  console.assert(y <= maximumY)
  console.assert(normalizedX >= 0)
  console.assert(normalizedX <= 1)
  console.assert(normalizedY >= 0)
  console.assert(normalizedY <= 1)
  console.assert(normalizedWidth >= 0)
  console.assert(normalizedWidth <= 1)
  console.assert(normalizedHeight >= 0)
  console.assert(normalizedHeight <= 1)

  return {
    x,
    y,
    width,
    height,
    minimumWidth,
    minimumHeight,
    maximumX,
    maximumY,
    normalizedX,
    normalizedY,
    normalizedWidth,
    normalizedHeight,
  }
}

function calculateTimelineMetrics(
  trackWidth: number,
  handleWidth: number,
  requestedStart: number,
  requestedEnd: number,
  requestedPlayhead: number,
): TimelineMetrics {
  console.assert(trackWidth >= 1)
  console.assert(trackWidth <= maximumViewportWidth)
  console.assert(handleWidth >= 1)
  console.assert(handleWidth <= 24)

  const requestedMinimumClipDuration = (handleWidth * 2 * mediaDuration) / trackWidth
  const minimumClipDuration = Math.min(mediaDuration, Math.max(0, requestedMinimumClipDuration))
  const maximumStart = Math.max(0, mediaDuration - minimumClipDuration)
  const start = Math.min(maximumStart, Math.max(0, requestedStart))
  const minimumEnd = Math.min(mediaDuration, Math.max(start, start + minimumClipDuration))
  const end = Math.min(mediaDuration, Math.max(minimumEnd, requestedEnd))
  const playhead = Math.min(end, Math.max(start, requestedPlayhead))
  const rawStartX = trackWidth * (start / mediaDuration)
  const rawEndX = trackWidth * (end / mediaDuration)
  const rawPlayheadX = trackWidth * (playhead / mediaDuration)
  const startX = Math.min(trackWidth, Math.max(0, rawStartX))
  const endX = Math.min(trackWidth, Math.max(startX, rawEndX))
  const playheadX = Math.min(endX, Math.max(startX, rawPlayheadX))
  const clipWidth = Math.min(trackWidth, Math.max(0, endX - startX))

  console.assert(minimumClipDuration >= 0)
  console.assert(minimumClipDuration <= mediaDuration)
  console.assert(maximumStart >= 0)
  console.assert(start >= 0)
  console.assert(start <= maximumStart)
  console.assert(minimumEnd >= start)
  console.assert(minimumEnd <= mediaDuration)
  console.assert(end >= minimumEnd)
  console.assert(end <= mediaDuration)
  console.assert(playhead >= start)
  console.assert(playhead <= end)
  console.assert(startX >= 0)
  console.assert(startX <= trackWidth)
  console.assert(endX >= startX)
  console.assert(endX <= trackWidth)
  console.assert(playheadX >= startX)
  console.assert(playheadX <= endX)
  console.assert(clipWidth >= 0)
  console.assert(clipWidth <= trackWidth)

  return {
    duration: mediaDuration,
    minimumClipDuration,
    maximumStart,
    start,
    minimumEnd,
    end,
    playhead,
    startX,
    endX,
    playheadX,
    clipWidth,
  }
}

function calculateMenuMetrics(
  stageWidth: number,
  stageHeight: number,
  expanded: boolean,
  snapRight: boolean,
  snapBottom: boolean,
): MenuMetrics {
  console.assert(stageWidth >= 1)
  console.assert(stageWidth <= maximumViewportWidth)
  console.assert(stageHeight >= 1)
  console.assert(stageHeight <= maximumViewportHeight)

  const shortestSide = Math.min(stageWidth, stageHeight)
  const maximumInset = Math.min(22, Math.max(0, shortestSide / 2))
  const minimumInset = Math.min(14, maximumInset)
  const inset = Math.min(maximumInset, Math.max(minimumInset, shortestSide * 0.025))
  const availableWidth = Math.max(0, stageWidth - inset * 2)
  const availableHeight = Math.max(0, stageHeight - inset * 2)
  const requestedPanelWidth = Math.min(244, Math.max(184, stageWidth * 0.24))
  const requestedWidth = expanded ? requestedPanelWidth + 8 + 48 : 48
  const requestedHeight = expanded ? Math.min(160, Math.max(96, stageHeight * 0.62)) : 48
  const width = Math.min(availableWidth, Math.max(0, requestedWidth))
  const height = Math.min(availableHeight, Math.max(0, requestedHeight))
  const launcherSize = Math.min(48, Math.max(0, Math.min(width, height)))
  const panelGap = expanded ? Math.min(8, Math.max(0, width - launcherSize)) : 0
  const panelWidth = expanded ? Math.max(0, width - launcherSize - panelGap) : 0
  const panelHeight = expanded ? height : 0
  const maximumPanelX = Math.max(0, width - panelWidth)
  const requestedPanelX = snapRight ? 0 : launcherSize + panelGap
  const panelX = Math.min(maximumPanelX, Math.max(0, requestedPanelX))
  const panelY = 0
  const horizontalTravel = Math.max(0, availableWidth - width)
  const verticalTravel = Math.max(0, availableHeight - height)
  const requestedX = snapRight ? horizontalTravel : 0
  const requestedY = snapBottom ? verticalTravel : 0
  const x = Math.min(horizontalTravel, Math.max(0, requestedX))
  const y = Math.min(verticalTravel, Math.max(0, requestedY))
  const maximumLauncherX = Math.max(0, width - launcherSize)
  const maximumLauncherY = Math.max(0, height - launcherSize)
  const requestedLauncherX = snapRight ? maximumLauncherX : 0
  const requestedLauncherY = snapBottom ? maximumLauncherY : 0
  const launcherX = Math.min(maximumLauncherX, Math.max(0, requestedLauncherX))
  const launcherY = Math.min(maximumLauncherY, Math.max(0, requestedLauncherY))

  console.assert(minimumInset >= 0)
  console.assert(minimumInset <= maximumInset)
  console.assert(inset >= minimumInset)
  console.assert(inset <= maximumInset)
  console.assert(availableWidth >= 0)
  console.assert(availableHeight >= 0)
  console.assert(width >= 0)
  console.assert(width <= availableWidth)
  console.assert(height >= 0)
  console.assert(height <= availableHeight)
  console.assert(panelGap >= 0)
  console.assert(panelGap <= 8)
  console.assert(panelWidth >= 0)
  console.assert(panelHeight >= 0)
  console.assert(panelX >= 0)
  console.assert(panelX <= maximumPanelX)
  console.assert(launcherSize >= 0)
  console.assert(launcherSize <= 48)
  console.assert(horizontalTravel >= 0)
  console.assert(verticalTravel >= 0)
  console.assert(x >= 0)
  console.assert(x <= horizontalTravel)
  console.assert(y >= 0)
  console.assert(y <= verticalTravel)
  console.assert(launcherX >= 0)
  console.assert(launcherX <= maximumLauncherX)
  console.assert(launcherY >= 0)
  console.assert(launcherY <= maximumLauncherY)

  return {
    inset,
    width,
    height,
    panelGap,
    panelX,
    panelY,
    panelWidth,
    panelHeight,
    launcherSize,
    horizontalTravel,
    verticalTravel,
    x: inset + x,
    y: inset + y,
    launcherX,
    launcherY,
  }
}

function rectangle(x: number, y: number, width: number, height: number): Rectangle {
  return {x, y, width: Math.max(0, width), height: Math.max(0, height)}
}

function rectangleFromCenter(centerX: number, centerY: number, size: number): Rectangle {
  return rectangle(centerX - size / 2, centerY - size / 2, size, size)
}

function rectangleContainsPoint(value: Rectangle, x: number, y: number): boolean {
  return x >= value.x
    && x <= value.x + value.width
    && y >= value.y
    && y <= value.y + value.height
}

function translatedRectangle(value: Rectangle, x: number, y: number): Rectangle {
  return {x: value.x + x, y: value.y + y, width: value.width, height: value.height}
}

function cornerAxes(corner: Corner): {right: boolean; bottom: boolean} {
  switch (corner) {
    case 'topLeft': return {right: false, bottom: false}
    case 'topRight': return {right: true, bottom: false}
    case 'bottomRight': return {right: true, bottom: true}
    case 'bottomLeft': return {right: false, bottom: true}
  }
  throw new Error('Unreachable corner')
}

function cornerFromPoint(stage: Rectangle, pageX: number, pageY: number): Corner {
  const right = pageX >= stage.x + stage.width / 2
  const bottom = pageY >= stage.y + stage.height / 2
  if (right && bottom) return 'bottomRight'
  if (right) return 'topRight'
  if (bottom) return 'bottomLeft'
  return 'topLeft'
}

function freeMenuMetrics(
  stageWidth: number,
  stageHeight: number,
  requestedX: number,
  requestedY: number,
): MenuMetrics {
  const base = calculateMenuMetrics(stageWidth, stageHeight, false, false, false)
  const maximumX = Math.max(base.inset, stageWidth - base.inset - base.width)
  const maximumY = Math.max(base.inset, stageHeight - base.inset - base.height)
  const x = Math.min(maximumX, Math.max(base.inset, requestedX))
  const y = Math.min(maximumY, Math.max(base.inset, requestedY))
  return {
    inset: base.inset,
    width: base.width,
    height: base.height,
    panelGap: base.panelGap,
    panelX: base.panelX,
    panelY: base.panelY,
    panelWidth: base.panelWidth,
    panelHeight: base.panelHeight,
    launcherSize: base.launcherSize,
    horizontalTravel: Math.max(0, maximumX - base.inset),
    verticalTravel: Math.max(0, maximumY - base.inset),
    x,
    y,
    launcherX: 0,
    launcherY: 0,
  }
}

function cropHandleRectangles(crop: Rectangle, hitSize: number): CropHandleRectangles {
  const left = crop.x
  const centerX = crop.x + crop.width / 2
  const right = crop.x + crop.width
  const top = crop.y
  const centerY = crop.y + crop.height / 2
  const bottom = crop.y + crop.height
  return {
    nw: rectangleFromCenter(left, top, hitSize),
    n: rectangleFromCenter(centerX, top, hitSize),
    ne: rectangleFromCenter(right, top, hitSize),
    e: rectangleFromCenter(right, centerY, hitSize),
    se: rectangleFromCenter(right, bottom, hitSize),
    s: rectangleFromCenter(centerX, bottom, hitSize),
    sw: rectangleFromCenter(left, bottom, hitSize),
    w: rectangleFromCenter(left, centerY, hitSize),
  }
}

function cropHandleAtPoint(handles: CropHandleRectangles, x: number, y: number): ResizeHandle | null {
  if (rectangleContainsPoint(handles.nw, x, y)) return 'nw'
  if (rectangleContainsPoint(handles.n, x, y)) return 'n'
  if (rectangleContainsPoint(handles.ne, x, y)) return 'ne'
  if (rectangleContainsPoint(handles.e, x, y)) return 'e'
  if (rectangleContainsPoint(handles.se, x, y)) return 'se'
  if (rectangleContainsPoint(handles.s, x, y)) return 's'
  if (rectangleContainsPoint(handles.sw, x, y)) return 'sw'
  if (rectangleContainsPoint(handles.w, x, y)) return 'w'
  return null
}

function calculatePageLayout(
  viewportWidth: number,
  viewportHeight: number,
  cropX: number,
  cropY: number,
  cropWidth: number,
  cropHeight: number,
  trimStart: number,
  trimEnd: number,
  playhead: number,
  menuCorner: Corner,
  menuExpanded: boolean,
  drag: Drag | null,
): PageLayout {
  const frame = calculateFrameMetrics(viewportWidth, viewportHeight)
  const videoMetrics = calculateVideoMetrics(frame.stage.width, frame.stage.height)
  const cropHandleSize = Math.min(14, Math.max(10, viewportWidth * 0.009))
  const cropMetrics = calculateCropMetrics(
    Math.max(1, videoMetrics.width),
    Math.max(1, videoMetrics.height),
    cropHandleSize,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
  )
  const trimHandleWidth = Math.min(16, Math.max(10, viewportWidth * 0.009))
  const timelineMetrics = calculateTimelineMetrics(
    frame.timelineTrack.width,
    trimHandleWidth,
    trimStart,
    trimEnd,
    playhead,
  )
  const axes = cornerAxes(menuCorner)
  let menuMetrics = calculateMenuMetrics(
    frame.stage.width,
    frame.stage.height,
    menuExpanded,
    axes.right,
    axes.bottom,
  )
  if (drag != null && drag.kind === 'menu') {
    const requestedMenuX = drag.currentX - frame.stage.x - drag.offsetX
    const requestedMenuY = drag.currentY - frame.stage.y - drag.offsetY
    const finiteRequestedMenuX = Number.isFinite(requestedMenuX) ? requestedMenuX : menuMetrics.x
    const finiteRequestedMenuY = Number.isFinite(requestedMenuY) ? requestedMenuY : menuMetrics.y
    menuMetrics = freeMenuMetrics(
      frame.stage.width,
      frame.stage.height,
      finiteRequestedMenuX,
      finiteRequestedMenuY,
    )
  }

  const videoInStage = rectangle(
    videoMetrics.offsetX,
    videoMetrics.offsetY,
    videoMetrics.width,
    videoMetrics.height,
  )
  const videoOnPage = translatedRectangle(videoInStage, frame.stage.x, frame.stage.y)
  const cropInVideo = rectangle(cropMetrics.x, cropMetrics.y, cropMetrics.width, cropMetrics.height)
  const cropOnPage = translatedRectangle(cropInVideo, videoOnPage.x, videoOnPage.y)
  const cropFormulaHeight = 38
  const cropFormulaInset = 6
  const cropFormulaFitsInside = cropMetrics.width >= 340 && cropMetrics.height >= cropFormulaHeight + cropFormulaInset * 2
  const maximumCropFormulaY = Math.max(cropFormulaInset, videoMetrics.height - cropFormulaInset - cropFormulaHeight)
  const requestedCropFormulaY = cropFormulaFitsInside ? cropMetrics.y + cropFormulaInset : maximumCropFormulaY
  const cropFormulaY = Math.min(maximumCropFormulaY, Math.max(cropFormulaInset, requestedCropFormulaY))
  const requestedCropFormulaX = cropFormulaFitsInside ? cropMetrics.x + cropFormulaInset : cropFormulaInset
  const maximumCropFormulaX = Math.max(cropFormulaInset, videoMetrics.width - cropFormulaInset)
  const cropFormulaX = Math.min(maximumCropFormulaX, Math.max(cropFormulaInset, requestedCropFormulaX))
  const cropFormulaWidth = cropFormulaFitsInside
    ? Math.max(0, cropMetrics.width - cropFormulaInset * 2)
    : Math.max(0, videoMetrics.width - cropFormulaInset * 2)
  const cropFormulaInVideo = rectangle(
    cropFormulaX,
    cropFormulaY,
    cropFormulaWidth,
    cropFormulaHeight,
  )
  const cropHandlesOnPage = cropHandleRectangles(cropOnPage, cropHandleSize + 10)
  const timelineTrackOnPage = translatedRectangle(frame.timelineTrack, frame.timeline.x, frame.timeline.y)
  const clipTop = Math.max(26, frame.timelineTrack.height * 0.46)
  const requestedClipHeight = Math.max(26, frame.timelineTrack.height - clipTop - 7)
  const clipHeight = Math.max(1, Math.min(frame.timelineTrack.height - clipTop, requestedClipHeight))
  const clipInTrack = rectangle(timelineMetrics.startX, clipTop, timelineMetrics.clipWidth, clipHeight)
  const clipOnPage = translatedRectangle(clipInTrack, timelineTrackOnPage.x, timelineTrackOnPage.y)
  const trimHitWidth = trimHandleWidth + 12
  const trimStartOnPage = rectangle(
    clipOnPage.x - trimHitWidth / 2,
    clipOnPage.y,
    trimHitWidth,
    clipOnPage.height,
  )
  const trimEndOnPage = rectangle(
    clipOnPage.x + clipOnPage.width - trimHitWidth / 2,
    clipOnPage.y,
    trimHitWidth,
    clipOnPage.height,
  )
  const playheadInTrack = rectangle(timelineMetrics.playheadX, 0, 1, frame.timelineTrack.height)
  const playheadOnPage = translatedRectangle(playheadInTrack, timelineTrackOnPage.x, timelineTrackOnPage.y)
  const menuInStage = rectangle(menuMetrics.x, menuMetrics.y, menuMetrics.width, menuMetrics.height)
  const menuPanelInRoot = rectangle(
    menuMetrics.panelX,
    menuMetrics.panelY,
    menuMetrics.panelWidth,
    menuMetrics.panelHeight,
  )
  const menuLauncherInRoot = rectangle(
    menuMetrics.launcherX,
    menuMetrics.launcherY,
    menuMetrics.launcherSize,
    menuMetrics.launcherSize,
  )
  const menuLauncherOnPage = translatedRectangle(
    menuLauncherInRoot,
    frame.stage.x + menuInStage.x,
    frame.stage.y + menuInStage.y,
  )
  const topLeftMenu = calculateMenuMetrics(frame.stage.width, frame.stage.height, false, false, false)
  const topRightMenu = calculateMenuMetrics(frame.stage.width, frame.stage.height, false, true, false)
  const bottomRightMenu = calculateMenuMetrics(frame.stage.width, frame.stage.height, false, true, true)
  const bottomLeftMenu = calculateMenuMetrics(frame.stage.width, frame.stage.height, false, false, true)
  const targetSize = topLeftMenu.launcherSize
  const menuTargetsInStage = {
    topLeft: rectangle(topLeftMenu.x, topLeftMenu.y, targetSize, targetSize),
    topRight: rectangle(topRightMenu.x, topRightMenu.y, targetSize, targetSize),
    bottomRight: rectangle(bottomRightMenu.x, bottomRightMenu.y, targetSize, targetSize),
    bottomLeft: rectangle(bottomLeftMenu.x, bottomLeftMenu.y, targetSize, targetSize),
  }

  return {
    frame,
    videoMetrics,
    cropMetrics,
    timelineMetrics,
    menuMetrics,
    videoInStage,
    videoOnPage,
    cropInVideo,
    cropFormulaInVideo,
    cropOnPage,
    cropHandlesOnPage,
    timelineTrackOnPage,
    clipInTrack,
    clipOnPage,
    trimStartOnPage,
    trimEndOnPage,
    playheadInTrack,
    playheadOnPage,
    menuInStage,
    menuPanelInRoot,
    menuLauncherInRoot,
    menuLauncherOnPage,
    menuTargetsInStage,
  }
}

function requiredElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector)
  if (element == null) throw new Error(`Missing ${selector}`)
  return element
}

type DomCache = {
  app: HTMLElement
  toolbar: HTMLElement
  stage: HTMLElement
  timeline: HTMLElement
  timelineTrack: HTMLElement
  videoShell: HTMLElement
  cropFrame: HTMLElement
  trimClip: HTMLElement
  trimStart: HTMLButtonElement
  trimEnd: HTMLButtonElement
  playhead: HTMLButtonElement
  menuRoot: HTMLElement
  menuPanel: HTMLElement
  menuLauncher: HTMLButtonElement
  snapTopLeft: HTMLElement
  snapTopRight: HTMLElement
  snapBottomRight: HTMLElement
  snapBottomLeft: HTMLElement
  stageFormula: HTMLElement
  videoFormula: HTMLElement
  cropFormula: HTMLElement
  timelineFormula: HTMLElement
  clipLabel: HTMLElement
  menuFormula: HTMLElement
  viewportWarning: HTMLOutputElement
}

const dom: DomCache = {
  app: requiredElement<HTMLElement>('#app'), // cache lifetime: page
  toolbar: requiredElement<HTMLElement>('#toolbar'), // cache lifetime: page
  stage: requiredElement<HTMLElement>('#stage'), // cache lifetime: page
  timeline: requiredElement<HTMLElement>('#timeline'), // cache lifetime: page
  timelineTrack: requiredElement<HTMLElement>('#timeline-track'), // cache lifetime: page
  videoShell: requiredElement<HTMLElement>('#video-shell'), // cache lifetime: page; stateful video stays attached
  cropFrame: requiredElement<HTMLElement>('#crop-frame'), // cache lifetime: page
  trimClip: requiredElement<HTMLElement>('#trim-clip'), // cache lifetime: page
  trimStart: requiredElement<HTMLButtonElement>('#trim-start'), // cache lifetime: page
  trimEnd: requiredElement<HTMLButtonElement>('#trim-end'), // cache lifetime: page
  playhead: requiredElement<HTMLButtonElement>('#playhead'), // cache lifetime: page
  menuRoot: requiredElement<HTMLElement>('#menu-root'), // cache lifetime: page
  menuPanel: requiredElement<HTMLElement>('#menu-panel'), // cache lifetime: page
  menuLauncher: requiredElement<HTMLButtonElement>('#menu-launcher'), // cache lifetime: page
  snapTopLeft: requiredElement<HTMLElement>('#snap-top-left'), // cache lifetime: page
  snapTopRight: requiredElement<HTMLElement>('#snap-top-right'), // cache lifetime: page
  snapBottomRight: requiredElement<HTMLElement>('#snap-bottom-right'), // cache lifetime: page
  snapBottomLeft: requiredElement<HTMLElement>('#snap-bottom-left'), // cache lifetime: page
  stageFormula: requiredElement<HTMLElement>('#stage-formula'), // cache lifetime: page
  videoFormula: requiredElement<HTMLElement>('#video-formula'), // cache lifetime: page
  cropFormula: requiredElement<HTMLElement>('#crop-formula'), // cache lifetime: page
  timelineFormula: requiredElement<HTMLElement>('#timeline-formula'), // cache lifetime: page
  clipLabel: requiredElement<HTMLElement>('#clip-label'), // cache lifetime: page
  menuFormula: requiredElement<HTMLElement>('#menu-formula'), // cache lifetime: page
  viewportWarning: requiredElement<HTMLOutputElement>('#viewport-warning'), // cache lifetime: page
}

let state: EditorState = {
  cropX: 0.16,
  cropY: 0.14,
  cropWidth: 0.68,
  cropHeight: 0.72,
  trimStart: 18,
  trimEnd: 72,
  playhead: 42,
  menuCorner: 'bottomRight',
  menuExpanded: true,
  layoutInitialized: false,
  drag: null,
  pointerClientX: -1_000_000,
  pointerClientY: -1_000_000,
  latestTouchTime: null,
  events: [],
}

let scheduledAnimationFrame: number | null = null

function scheduleRender(): void {
  if (scheduledAnimationFrame != null) return
  scheduledAnimationFrame = requestAnimationFrame(function renderAndClearSchedule(time): void {
    scheduledAnimationFrame = null
    render(time)
  })
}

function queueMouseInput(event: MouseEvent, phase: InputPhase): void {
  state.events.push({
    kind: 'pointer',
    source: 'mouse',
    phase,
    pointerId: 1,
    pageX: event.pageX,
    pageY: event.pageY,
    clientX: event.clientX,
    clientY: event.clientY,
    button: event.button,
    timeStamp: event.timeStamp,
  })
  scheduleRender()
}

function queueTouchInput(event: TouchEvent, phase: InputPhase): void {
  for (let index = 0; index < event.changedTouches.length; index++) {
    const touch = event.changedTouches.item(index)
    if (touch == null) continue
    state.events.push({
      kind: 'pointer',
      source: 'touch',
      phase,
      pointerId: touch.identifier,
      pageX: touch.pageX,
      pageY: touch.pageY,
      clientX: touch.clientX,
      clientY: touch.clientY,
      button: 0,
      timeStamp: event.timeStamp,
    })
  }
  scheduleRender()
}

function queueGlobalCancel(reason: GlobalCancelInput['reason'], timeStamp: number): void {
  state.events.push({
    kind: 'globalCancel',
    reason,
    timeStamp,
  })
  scheduleRender()
}

window.addEventListener('resize', scheduleRender)
window.addEventListener('mousedown', event => queueMouseInput(event, 'down'))
window.addEventListener('mousemove', event => queueMouseInput(event, 'move'))
window.addEventListener('mouseup', event => queueMouseInput(event, 'up'))
window.addEventListener('contextmenu', event => {
  event.preventDefault()
  queueGlobalCancel('contextmenu', event.timeStamp)
})
window.addEventListener('blur', event => queueGlobalCancel('blur', event.timeStamp))
window.addEventListener('touchstart', event => queueTouchInput(event, 'down'), {passive: true})
window.addEventListener('touchmove', event => queueTouchInput(event, 'move'), {passive: true})
window.addEventListener('touchend', event => queueTouchInput(event, 'up'), {passive: true})
window.addEventListener('touchcancel', event => queueTouchInput(event, 'cancel'), {passive: true})
window.addEventListener('keydown', event => {
  const target = event.target instanceof HTMLElement ? event.target : null
  const targetId = target?.id ?? ''
  const targetHandle = target?.dataset['handle'] ?? ''
  const isArrowKey = event.code === 'ArrowLeft'
    || event.code === 'ArrowRight'
    || event.code === 'ArrowUp'
    || event.code === 'ArrowDown'
  const isActivationKey = event.code === 'Space' || event.code === 'Enter'
  const isSliderKey = isArrowKey || event.code === 'Home' || event.code === 'End'
  const handlesKey = (targetId === 'menu-launcher' && (isArrowKey || isActivationKey))
    || (targetId === 'crop-frame' && isArrowKey)
    || (targetHandle !== '' && (isArrowKey || isActivationKey))
    || ((targetId === 'trim-start' || targetId === 'trim-end' || targetId === 'playhead') && isSliderKey)
  if (handlesKey) event.preventDefault()
  state.events.push({
    kind: 'key',
    code: event.code,
    shiftKey: event.shiftKey,
    repeat: event.repeat,
    targetId,
    targetHandle,
    timeStamp: event.timeStamp,
  })
  scheduleRender()
})

function resizeAnchor(handle: ResizeHandle, crop: CropMetrics): {x: number; y: number} {
  const left = crop.normalizedX
  const top = crop.normalizedY
  const right = crop.normalizedX + crop.normalizedWidth
  const bottom = crop.normalizedY + crop.normalizedHeight
  switch (handle) {
    case 'nw': return {x: right, y: bottom}
    case 'n': return {x: left, y: bottom}
    case 'ne': return {x: left, y: bottom}
    case 'e': return {x: left, y: top}
    case 'se': return {x: left, y: top}
    case 's': return {x: left, y: top}
    case 'sw': return {x: right, y: top}
    case 'w': return {x: right, y: top}
  }
  throw new Error('Unreachable crop handle')
}

function resizeHandlePoint(handle: ResizeHandle, crop: CropMetrics): {x: number; y: number} {
  const left = crop.normalizedX
  const top = crop.normalizedY
  const right = crop.normalizedX + crop.normalizedWidth
  const bottom = crop.normalizedY + crop.normalizedHeight
  const centerX = left + crop.normalizedWidth / 2
  const centerY = top + crop.normalizedHeight / 2
  switch (handle) {
    case 'nw': return {x: left, y: top}
    case 'n': return {x: centerX, y: top}
    case 'ne': return {x: right, y: top}
    case 'e': return {x: right, y: centerY}
    case 'se': return {x: right, y: bottom}
    case 's': return {x: centerX, y: bottom}
    case 'sw': return {x: left, y: bottom}
    case 'w': return {x: left, y: centerY}
  }
  throw new Error('Unreachable crop handle')
}

function calculateCropResizeRequest(
  handle: ResizeHandle,
  crop: CropMetrics,
  videoWidth: number,
  videoHeight: number,
  anchorX: number,
  anchorY: number,
  pointerX: number,
  pointerY: number,
): CropRequest {
  const minimumWidth = crop.minimumWidth / Math.max(1, videoWidth)
  const minimumHeight = crop.minimumHeight / Math.max(1, videoHeight)
  const movesLeft = handle === 'nw' || handle === 'w' || handle === 'sw'
  const movesRight = handle === 'ne' || handle === 'e' || handle === 'se'
  const movesTop = handle === 'nw' || handle === 'n' || handle === 'ne'
  const movesBottom = handle === 'sw' || handle === 's' || handle === 'se'
  const maximumLeft = Math.max(0, anchorX - minimumWidth)
  const minimumRight = Math.min(1, anchorX + minimumWidth)
  const maximumTop = Math.max(0, anchorY - minimumHeight)
  const minimumBottom = Math.min(1, anchorY + minimumHeight)
  const left = movesLeft
    ? Math.min(maximumLeft, Math.max(0, pointerX))
    : movesRight ? anchorX : crop.normalizedX
  const right = movesRight
    ? Math.min(1, Math.max(minimumRight, pointerX))
    : movesLeft ? anchorX : crop.normalizedX + crop.normalizedWidth
  const top = movesTop
    ? Math.min(maximumTop, Math.max(0, pointerY))
    : movesBottom ? anchorY : crop.normalizedY
  const bottom = movesBottom
    ? Math.min(1, Math.max(minimumBottom, pointerY))
    : movesTop ? anchorY : crop.normalizedY + crop.normalizedHeight
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  }
}

function cursorForResizeHandle(handle: ResizeHandle): string {
  switch (handle) {
    case 'nw':
    case 'se': return 'nwse-resize'
    case 'ne':
    case 'sw': return 'nesw-resize'
    case 'n':
    case 's': return 'ns-resize'
    case 'e':
    case 'w': return 'ew-resize'
  }
  throw new Error('Unreachable crop handle')
}

function cursorForLayout(layout: PageLayout, pointerX: number, pointerY: number, drag: Drag | null): string {
  if (drag != null) {
    switch (drag.kind) {
      case 'cropMove': return 'grabbing'
      case 'cropResize': return cursorForResizeHandle(drag.handle)
      case 'trimStart':
      case 'trimEnd':
      case 'playhead': return 'ew-resize'
      case 'menu': return 'grabbing'
    }
  }
  if (rectangleContainsPoint(layout.menuLauncherOnPage, pointerX, pointerY)) return 'grab'
  const cropHandle = cropHandleAtPoint(layout.cropHandlesOnPage, pointerX, pointerY)
  if (cropHandle != null) return cursorForResizeHandle(cropHandle)
  if (rectangleContainsPoint(layout.cropOnPage, pointerX, pointerY)) return 'move'
  if (rectangleContainsPoint(layout.trimStartOnPage, pointerX, pointerY)) return 'ew-resize'
  if (rectangleContainsPoint(layout.trimEndOnPage, pointerX, pointerY)) return 'ew-resize'
  if (rectangleContainsPoint(layout.timelineTrackOnPage, pointerX, pointerY)) return 'ew-resize'
  return 'default'
}

function setRectangle(element: HTMLElement, value: Rectangle): void {
  element.style.left = `${value.x}px`
  element.style.top = `${value.y}px`
  element.style.width = `${value.width}px`
  element.style.height = `${value.height}px`
}

function metric(value: number): string {
  return value.toFixed(1)
}

function time(value: number): string {
  const minutes = Math.floor(value / 60)
  const seconds = value - minutes * 60
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`
}

function isResizeHandle(value: string): value is ResizeHandle {
  return value === 'nw'
    || value === 'n'
    || value === 'ne'
    || value === 'e'
    || value === 'se'
    || value === 's'
    || value === 'sw'
    || value === 'w'
}

function render(_time: number): void {
  // DOM reads
  const measuredViewportWidth = document.documentElement.clientWidth
  const measuredViewportHeight = document.documentElement.clientHeight
  const viewportWidth = Math.min(maximumViewportWidth, Math.max(minimumViewportWidth, measuredViewportWidth))
  const viewportHeight = Math.min(maximumViewportHeight, Math.max(minimumViewportHeight, measuredViewportHeight))
  const viewportSupported = measuredViewportWidth >= minimumViewportWidth
    && measuredViewportWidth <= maximumViewportWidth
    && measuredViewportHeight >= minimumViewportHeight
    && measuredViewportHeight <= maximumViewportHeight

  // Input interpretation and state changes
  let requestedCropX = state.cropX
  let requestedCropY = state.cropY
  let requestedCropWidth = state.cropWidth
  let requestedCropHeight = state.cropHeight
  let requestedTrimStart = state.trimStart
  let requestedTrimEnd = state.trimEnd
  let requestedPlayhead = state.playhead
  let menuCorner = state.menuCorner
  const initialFrame = calculateFrameMetrics(viewportWidth, viewportHeight)
  let menuExpanded = state.layoutInitialized
    ? state.menuExpanded
    : state.menuExpanded && initialFrame.stage.height >= 240
  let drag = state.drag
  let pointerClientX = state.pointerClientX
  let pointerClientY = state.pointerClientY
  let latestTouchTime = state.latestTouchTime

  for (const input of state.events) {
    const inputLayout = calculatePageLayout(
      viewportWidth,
      viewportHeight,
      requestedCropX,
      requestedCropY,
      requestedCropWidth,
      requestedCropHeight,
      requestedTrimStart,
      requestedTrimEnd,
      requestedPlayhead,
      menuCorner,
      menuExpanded,
      drag,
    )

    if (input.kind === 'globalCancel') {
      drag = null
      continue
    }

    if (input.kind === 'key') {
      if (input.code === 'Escape') {
        if (drag == null) menuExpanded = false
        drag = null
        continue
      }
      if (input.code === 'KeyM' && !input.repeat) {
        menuExpanded = !menuExpanded
        continue
      }
      if (input.targetId === 'menu-launcher') {
        if ((input.code === 'Space' || input.code === 'Enter') && !input.repeat) {
          menuExpanded = !menuExpanded
        } else if (input.code === 'ArrowLeft') {
          menuCorner = menuCorner === 'topLeft' || menuCorner === 'topRight' ? 'topLeft' : 'bottomLeft'
        } else if (input.code === 'ArrowRight') {
          menuCorner = menuCorner === 'topLeft' || menuCorner === 'topRight' ? 'topRight' : 'bottomRight'
        } else if (input.code === 'ArrowUp') {
          menuCorner = menuCorner === 'topLeft' || menuCorner === 'bottomLeft' ? 'topLeft' : 'topRight'
        } else if (input.code === 'ArrowDown') {
          menuCorner = menuCorner === 'topLeft' || menuCorner === 'bottomLeft' ? 'bottomLeft' : 'bottomRight'
        }
        continue
      }

      const keyboardPixelStep = input.shiftKey ? 10 : 1
      const keyboardTimeStep = input.shiftKey ? 1 : 0.1
      const horizontalPixels = input.code === 'ArrowLeft'
        ? -keyboardPixelStep
        : input.code === 'ArrowRight' ? keyboardPixelStep : 0
      const verticalPixels = input.code === 'ArrowUp'
        ? -keyboardPixelStep
        : input.code === 'ArrowDown' ? keyboardPixelStep : 0

      if (input.targetId === 'crop-frame' && (horizontalPixels !== 0 || verticalPixels !== 0)) {
        requestedCropX = inputLayout.cropMetrics.normalizedX
          + horizontalPixels / Math.max(1, inputLayout.videoMetrics.width)
        requestedCropY = inputLayout.cropMetrics.normalizedY
          + verticalPixels / Math.max(1, inputLayout.videoMetrics.height)
        continue
      }

      if (isResizeHandle(input.targetHandle)) {
        const activatesResize = (input.code === 'Space' || input.code === 'Enter') && !input.repeat
        const resizeHorizontalPixels = activatesResize
          ? input.targetHandle === 'nw' || input.targetHandle === 'w' || input.targetHandle === 'sw'
            ? -keyboardPixelStep
            : input.targetHandle === 'ne' || input.targetHandle === 'e' || input.targetHandle === 'se'
              ? keyboardPixelStep
              : 0
          : horizontalPixels
        const resizeVerticalPixels = activatesResize
          ? input.targetHandle === 'nw' || input.targetHandle === 'n' || input.targetHandle === 'ne'
            ? -keyboardPixelStep
            : input.targetHandle === 'sw' || input.targetHandle === 's' || input.targetHandle === 'se'
              ? keyboardPixelStep
              : 0
          : verticalPixels
        if (resizeHorizontalPixels === 0 && resizeVerticalPixels === 0) continue
        const anchor = resizeAnchor(input.targetHandle, inputLayout.cropMetrics)
        const handlePoint = resizeHandlePoint(input.targetHandle, inputLayout.cropMetrics)
        const cropRequest = calculateCropResizeRequest(
          input.targetHandle,
          inputLayout.cropMetrics,
          inputLayout.videoMetrics.width,
          inputLayout.videoMetrics.height,
          anchor.x,
          anchor.y,
          handlePoint.x + resizeHorizontalPixels / Math.max(1, inputLayout.videoMetrics.width),
          handlePoint.y + resizeVerticalPixels / Math.max(1, inputLayout.videoMetrics.height),
        )
        requestedCropX = cropRequest.x
        requestedCropY = cropRequest.y
        requestedCropWidth = cropRequest.width
        requestedCropHeight = cropRequest.height
        continue
      }

      if (input.targetId === 'trim-start') {
        const maximumStart = Math.max(0, inputLayout.timelineMetrics.end - inputLayout.timelineMetrics.minimumClipDuration)
        const decreasesTime = input.code === 'ArrowLeft' || input.code === 'ArrowDown'
        const increasesTime = input.code === 'ArrowRight' || input.code === 'ArrowUp'
        if (input.code === 'Home') requestedTrimStart = 0
        if (input.code === 'End') requestedTrimStart = maximumStart
        if (decreasesTime) requestedTrimStart = Math.max(0, inputLayout.timelineMetrics.start - keyboardTimeStep)
        if (increasesTime) requestedTrimStart = Math.min(maximumStart, inputLayout.timelineMetrics.start + keyboardTimeStep)
        requestedTrimEnd = inputLayout.timelineMetrics.end
        continue
      }

      if (input.targetId === 'trim-end') {
        const minimumEnd = Math.min(mediaDuration, inputLayout.timelineMetrics.start + inputLayout.timelineMetrics.minimumClipDuration)
        const decreasesTime = input.code === 'ArrowLeft' || input.code === 'ArrowDown'
        const increasesTime = input.code === 'ArrowRight' || input.code === 'ArrowUp'
        if (input.code === 'Home') requestedTrimEnd = minimumEnd
        if (input.code === 'End') requestedTrimEnd = mediaDuration
        if (decreasesTime) requestedTrimEnd = Math.max(minimumEnd, inputLayout.timelineMetrics.end - keyboardTimeStep)
        if (increasesTime) requestedTrimEnd = Math.min(mediaDuration, inputLayout.timelineMetrics.end + keyboardTimeStep)
        requestedTrimStart = inputLayout.timelineMetrics.start
        continue
      }

      if (input.targetId === 'playhead') {
        const decreasesTime = input.code === 'ArrowLeft' || input.code === 'ArrowDown'
        const increasesTime = input.code === 'ArrowRight' || input.code === 'ArrowUp'
        if (input.code === 'Home') requestedPlayhead = inputLayout.timelineMetrics.start
        if (input.code === 'End') requestedPlayhead = inputLayout.timelineMetrics.end
        if (decreasesTime) requestedPlayhead = Math.max(inputLayout.timelineMetrics.start, inputLayout.timelineMetrics.playhead - keyboardTimeStep)
        if (increasesTime) requestedPlayhead = Math.min(inputLayout.timelineMetrics.end, inputLayout.timelineMetrics.playhead + keyboardTimeStep)
      }
      continue
    }

    const inputTimeStamp = Number.isFinite(input.timeStamp) ? input.timeStamp : 0
    if (input.source === 'touch') latestTouchTime = inputTimeStamp
    const activeMouseOwnsDrag = drag != null && drag.pointer.source === 'mouse'
    const followsTouch = input.source === 'mouse'
      && !activeMouseOwnsDrag
      && latestTouchTime != null
      && inputTimeStamp - latestTouchTime < 700
    if (followsTouch) continue
    if (input.source === 'mouse' && input.phase === 'up' && input.button !== 0) continue

    const pageX = Number.isFinite(input.pageX) ? input.pageX : inputLayout.frame.stage.x
    const pageY = Number.isFinite(input.pageY) ? input.pageY : inputLayout.frame.stage.y
    pointerClientX = Number.isFinite(input.clientX) ? input.clientX : pointerClientX
    pointerClientY = Number.isFinite(input.clientY) ? input.clientY : pointerClientY
    const pointer: PointerIdentity = {
      source: input.source,
      id: Number.isFinite(input.pointerId) ? input.pointerId : -1,
    }
    if (input.phase === 'cancel') {
      if (drag != null && drag.pointer.source === pointer.source && drag.pointer.id === pointer.id) drag = null
      continue
    }

    if (input.phase === 'down') {
      if (input.button !== 0 || drag != null) continue
      if (rectangleContainsPoint(inputLayout.menuLauncherOnPage, pageX, pageY)) {
        drag = {
          kind: 'menu',
          pointer,
          offsetX: pageX - inputLayout.menuLauncherOnPage.x,
          offsetY: pageY - inputLayout.menuLauncherOnPage.y,
          startX: pageX,
          startY: pageY,
          currentX: pageX,
          currentY: pageY,
          moved: false,
        }
        continue
      }
      const handle = cropHandleAtPoint(inputLayout.cropHandlesOnPage, pageX, pageY)
      if (handle != null) {
        const anchor = resizeAnchor(handle, inputLayout.cropMetrics)
        const handlePoint = resizeHandlePoint(handle, inputLayout.cropMetrics)
        const handlePageX = inputLayout.videoOnPage.x + handlePoint.x * inputLayout.videoOnPage.width
        const handlePageY = inputLayout.videoOnPage.y + handlePoint.y * inputLayout.videoOnPage.height
        drag = {
          kind: 'cropResize',
          pointer,
          handle,
          anchorX: anchor.x,
          anchorY: anchor.y,
          grabOffsetX: pageX - handlePageX,
          grabOffsetY: pageY - handlePageY,
        }
        continue
      }
      if (rectangleContainsPoint(inputLayout.cropOnPage, pageX, pageY)) {
        drag = {
          kind: 'cropMove',
          pointer,
          offsetX: pageX - inputLayout.cropOnPage.x,
          offsetY: pageY - inputLayout.cropOnPage.y,
        }
        continue
      }
      const trimStartHit = rectangleContainsPoint(inputLayout.trimStartOnPage, pageX, pageY)
      const trimEndHit = rectangleContainsPoint(inputLayout.trimEndOnPage, pageX, pageY)
      if (trimStartHit || trimEndHit) {
        const startX = inputLayout.clipOnPage.x
        const endX = inputLayout.clipOnPage.x + inputLayout.clipOnPage.width
        const useStart = trimStartHit && (!trimEndHit || Math.abs(pageX - startX) <= Math.abs(pageX - endX))
        drag = useStart
          ? {
            kind: 'trimStart',
            pointer,
            fixedEnd: inputLayout.timelineMetrics.end,
            grabOffsetX: pageX - startX,
          }
          : {
            kind: 'trimEnd',
            pointer,
            fixedStart: inputLayout.timelineMetrics.start,
            grabOffsetX: pageX - endX,
          }
        continue
      }
      if (rectangleContainsPoint(inputLayout.timelineTrackOnPage, pageX, pageY)) {
        drag = {kind: 'playhead', pointer, grabOffsetX: 0}
      }
      continue
    }

    if (drag == null) continue
    if (pointer.source !== drag.pointer.source || pointer.id !== drag.pointer.id) continue

    switch (drag.kind) {
      case 'cropMove': {
        requestedCropX = (pageX - inputLayout.videoOnPage.x - drag.offsetX)
          / Math.max(1, inputLayout.videoOnPage.width)
        requestedCropY = (pageY - inputLayout.videoOnPage.y - drag.offsetY)
          / Math.max(1, inputLayout.videoOnPage.height)
        break
      }
      case 'cropResize': {
        const pointerX = (pageX - inputLayout.videoOnPage.x - drag.grabOffsetX)
          / Math.max(1, inputLayout.videoOnPage.width)
        const pointerY = (pageY - inputLayout.videoOnPage.y - drag.grabOffsetY)
          / Math.max(1, inputLayout.videoOnPage.height)
        const cropRequest = calculateCropResizeRequest(
          drag.handle,
          inputLayout.cropMetrics,
          inputLayout.videoMetrics.width,
          inputLayout.videoMetrics.height,
          drag.anchorX,
          drag.anchorY,
          pointerX,
          pointerY,
        )
        requestedCropX = cropRequest.x
        requestedCropY = cropRequest.y
        requestedCropWidth = cropRequest.width
        requestedCropHeight = cropRequest.height
        break
      }
      case 'trimStart': {
        const fraction = (pageX - drag.grabOffsetX - inputLayout.timelineTrackOnPage.x)
          / Math.max(1, inputLayout.timelineTrackOnPage.width)
        const maximumStart = Math.max(0, drag.fixedEnd - inputLayout.timelineMetrics.minimumClipDuration)
        requestedTrimStart = Math.min(maximumStart, Math.max(0, fraction * mediaDuration))
        requestedTrimEnd = drag.fixedEnd
        break
      }
      case 'trimEnd': {
        const fraction = (pageX - drag.grabOffsetX - inputLayout.timelineTrackOnPage.x)
          / Math.max(1, inputLayout.timelineTrackOnPage.width)
        const minimumEnd = Math.min(mediaDuration, drag.fixedStart + inputLayout.timelineMetrics.minimumClipDuration)
        requestedTrimStart = drag.fixedStart
        requestedTrimEnd = Math.min(mediaDuration, Math.max(minimumEnd, fraction * mediaDuration))
        break
      }
      case 'playhead': {
        const fraction = (pageX - drag.grabOffsetX - inputLayout.timelineTrackOnPage.x)
          / Math.max(1, inputLayout.timelineTrackOnPage.width)
        requestedPlayhead = fraction * mediaDuration
        break
      }
      case 'menu': {
        const movedDistance = Math.abs(pageX - drag.startX) + Math.abs(pageY - drag.startY)
        drag = {
          kind: 'menu',
          pointer: drag.pointer,
          offsetX: drag.offsetX,
          offsetY: drag.offsetY,
          startX: drag.startX,
          startY: drag.startY,
          currentX: pageX,
          currentY: pageY,
          moved: drag.moved || movedDistance >= 6,
        }
        break
      }
    }

    if (input.phase === 'up') {
      if (drag.kind === 'menu') {
        menuCorner = cornerFromPoint(inputLayout.frame.stage, pageX, pageY)
        if (!drag.moved) menuExpanded = !menuExpanded
      }
      drag = null
    }
  }

  const layout = calculatePageLayout(
    viewportWidth,
    viewportHeight,
    requestedCropX,
    requestedCropY,
    requestedCropWidth,
    requestedCropHeight,
    requestedTrimStart,
    requestedTrimEnd,
    requestedPlayhead,
    menuCorner,
    menuExpanded,
    drag,
  )
  const cursor = cursorForLayout(layout, pointerClientX, pointerClientY, drag)

  // Commit state; derived geometry stays local to this frame.
  state = {
    cropX: layout.cropMetrics.normalizedX,
    cropY: layout.cropMetrics.normalizedY,
    cropWidth: layout.cropMetrics.normalizedWidth,
    cropHeight: layout.cropMetrics.normalizedHeight,
    trimStart: layout.timelineMetrics.start,
    trimEnd: layout.timelineMetrics.end,
    playhead: layout.timelineMetrics.playhead,
    menuCorner,
    menuExpanded,
    layoutInitialized: true,
    drag,
    pointerClientX,
    pointerClientY,
    latestTouchTime,
    events: [],
  }

  // DOM writes
  dom.app.style.width = `${measuredViewportWidth}px`
  dom.app.style.height = `${measuredViewportHeight}px`
  dom.app.dataset['viewportSupported'] = viewportSupported ? 'true' : 'false'
  setRectangle(dom.toolbar, layout.frame.toolbar)
  setRectangle(dom.stage, layout.frame.stage)
  setRectangle(dom.timeline, layout.frame.timeline)
  setRectangle(dom.videoShell, layout.videoInStage)
  setRectangle(dom.cropFrame, layout.cropInVideo)
  setRectangle(dom.cropFormula, layout.cropFormulaInVideo)
  dom.cropFrame.style.setProperty('--crop-handle-size', `${Math.min(14, Math.max(10, viewportWidth * 0.009))}px`)
  setRectangle(dom.timelineTrack, layout.frame.timelineTrack)
  setRectangle(dom.trimClip, layout.clipInTrack)
  dom.trimStart.style.width = `${Math.min(16, Math.max(10, viewportWidth * 0.009))}px`
  dom.trimEnd.style.width = `${Math.min(16, Math.max(10, viewportWidth * 0.009))}px`
  setRectangle(dom.playhead, layout.playheadInTrack)
  setRectangle(dom.menuRoot, layout.menuInStage)
  setRectangle(dom.menuPanel, layout.menuPanelInRoot)
  setRectangle(dom.menuLauncher, layout.menuLauncherInRoot)
  const menuPanelVisible = menuExpanded && (drag == null || drag.kind !== 'menu')
  dom.menuPanel.style.display = menuPanelVisible ? 'block' : 'none'
  dom.menuPanel.setAttribute('aria-hidden', menuPanelVisible ? 'false' : 'true')
  dom.menuLauncher.setAttribute('aria-expanded', menuExpanded ? 'true' : 'false')
  const snapOpacity = drag != null && drag.kind === 'menu' ? '1' : '0'
  setRectangle(dom.snapTopLeft, layout.menuTargetsInStage.topLeft)
  setRectangle(dom.snapTopRight, layout.menuTargetsInStage.topRight)
  setRectangle(dom.snapBottomRight, layout.menuTargetsInStage.bottomRight)
  setRectangle(dom.snapBottomLeft, layout.menuTargetsInStage.bottomLeft)
  dom.snapTopLeft.style.opacity = snapOpacity
  dom.snapTopRight.style.opacity = snapOpacity
  dom.snapBottomRight.style.opacity = snapOpacity
  dom.snapBottomLeft.style.opacity = snapOpacity
  dom.app.style.cursor = cursor

  const maximumInteractiveStart = Math.max(0, layout.timelineMetrics.end - layout.timelineMetrics.minimumClipDuration)
  const minimumInteractiveEnd = Math.min(mediaDuration, layout.timelineMetrics.start + layout.timelineMetrics.minimumClipDuration)
  const minimumMenuX = layout.menuMetrics.inset
  const maximumMenuX = layout.menuMetrics.inset + layout.menuMetrics.horizontalTravel
  const minimumMenuY = layout.menuMetrics.inset
  const maximumMenuY = layout.menuMetrics.inset + layout.menuMetrics.verticalTravel
  const menuDragFormula = drag != null && drag.kind === 'menu'
    ? `\nM drag x[${metric(minimumMenuX)},${metric(maximumMenuX)}]→${metric(layout.menuMetrics.x)} · y[${metric(minimumMenuY)},${metric(maximumMenuY)}]→${metric(layout.menuMetrics.y)}`
    : ''
  const stageFormula = viewportWidth <= 760 || viewportHeight <= 450
    ? `Hbar ${metric(layout.frame.toolbar.height)} · P ${metric(layout.frame.outerInset)}[16,28] · G ${metric(layout.frame.verticalGap)}[12,20]\nS ${metric(layout.frame.stage.width)}×${metric(layout.frame.stage.height)} · V ${metric(layout.videoMetrics.width)}×${metric(layout.videoMetrics.height)}\ngx ${metric(layout.videoMetrics.offsetX)}[0,${metric(layout.videoMetrics.horizontalTravel)}] · gy ${metric(layout.videoMetrics.offsetY)}[0,${metric(layout.videoMetrics.verticalTravel)}]`
    : `Hbar=${metric(layout.frame.toolbar.height)} · P=clamp(16,1.8vw,28)→${metric(layout.frame.outerInset)}px · G=clamp(12,1.8vh,20)→${metric(layout.frame.verticalGap)}px\nS ${metric(layout.frame.stage.width)}×${metric(layout.frame.stage.height)} · V ${metric(layout.videoMetrics.width)}×${metric(layout.videoMetrics.height)}\ngx ${metric(layout.videoMetrics.offsetX)}∈[0,${metric(layout.videoMetrics.horizontalTravel)}] · gy ${metric(layout.videoMetrics.offsetY)}∈[0,${metric(layout.videoMetrics.verticalTravel)}]`
  dom.stageFormula.textContent = stageFormula + menuDragFormula
  dom.videoFormula.textContent = `V final ${metric(layout.videoMetrics.width)}×${metric(layout.videoMetrics.height)} · contain gaps ${metric(layout.videoMetrics.offsetX)}×${metric(layout.videoMetrics.offsetY)}`
  dom.cropFormula.textContent = `C ${metric(layout.cropMetrics.width)}×${metric(layout.cropMetrics.height)} · w[${metric(layout.cropMetrics.minimumWidth)},${metric(layout.videoMetrics.width)}] h[${metric(layout.cropMetrics.minimumHeight)},${metric(layout.videoMetrics.height)}]\nx[0,${metric(layout.cropMetrics.maximumX)}]→${metric(layout.cropMetrics.x)} · y[0,${metric(layout.cropMetrics.maximumY)}]→${metric(layout.cropMetrics.y)}`
  dom.timelineFormula.textContent = `1 TRACK / 1 CLIP · TL${metric(layout.frame.timeline.height)}[108,168]\nI${metric(layout.frame.timelineTrackInset)}[14,22] · y${metric(layout.frame.timelineTrack.y)} · W${metric(layout.frame.timelineTrack.width)}×${metric(layout.frame.timelineTrack.height)} · Δmin${metric(layout.timelineMetrics.minimumClipDuration)}s\nS${metric(layout.timelineMetrics.start)}[0,${metric(maximumInteractiveStart)}] · E${metric(layout.timelineMetrics.end)}[${metric(minimumInteractiveEnd)},90] · P${metric(layout.timelineMetrics.playhead)}[${metric(layout.timelineMetrics.start)},${metric(layout.timelineMetrics.end)}]\nWclip=clamp(0,Δx,Wtrack)→${metric(layout.timelineMetrics.clipWidth)}px ∈[0,${metric(layout.frame.timelineTrack.width)}]`
  dom.clipLabel.textContent = `${time(layout.timelineMetrics.start)} → ${time(layout.timelineMetrics.end)} · ${metric(layout.timelineMetrics.clipWidth)}px`
  dom.menuFormula.textContent = drag != null && drag.kind === 'menu'
    ? `DRAG M${metric(layout.menuMetrics.width)}×${metric(layout.menuMetrics.height)}\nx[${metric(minimumMenuX)},${metric(maximumMenuX)}]→${metric(layout.menuMetrics.x)} y[${metric(minimumMenuY)},${metric(maximumMenuY)}]→${metric(layout.menuMetrics.y)}`
    : `M${metric(layout.menuMetrics.width)}×${metric(layout.menuMetrics.height)} P${metric(layout.menuMetrics.panelWidth)}×${metric(layout.menuMetrics.panelHeight)} L${metric(layout.menuMetrics.launcherSize)}+${metric(layout.menuMetrics.panelGap)}\nx{${metric(minimumMenuX)},${metric(maximumMenuX)}} y{${metric(minimumMenuY)},${metric(maximumMenuY)}} · ${menuCorner}`
  dom.viewportWarning.textContent = `Supported viewport: ${minimumViewportWidth}–${maximumViewportWidth} × ${minimumViewportHeight}–${maximumViewportHeight} CSS px.\nCurrent viewport: ${measuredViewportWidth} × ${measuredViewportHeight}.`
  dom.trimStart.setAttribute('aria-valuemin', '0')
  dom.trimStart.setAttribute('aria-valuemax', String(maximumInteractiveStart))
  dom.trimStart.setAttribute('aria-valuenow', String(layout.timelineMetrics.start))
  dom.trimStart.setAttribute('aria-valuetext', time(layout.timelineMetrics.start))
  dom.trimEnd.setAttribute('aria-valuemin', String(minimumInteractiveEnd))
  dom.trimEnd.setAttribute('aria-valuemax', String(mediaDuration))
  dom.trimEnd.setAttribute('aria-valuenow', String(layout.timelineMetrics.end))
  dom.trimEnd.setAttribute('aria-valuetext', time(layout.timelineMetrics.end))
  dom.playhead.setAttribute('aria-valuemin', String(layout.timelineMetrics.start))
  dom.playhead.setAttribute('aria-valuemax', String(layout.timelineMetrics.end))
  dom.playhead.setAttribute('aria-valuenow', String(layout.timelineMetrics.playhead))
  dom.playhead.setAttribute('aria-valuetext', time(layout.timelineMetrics.playhead))
}

render(0)
