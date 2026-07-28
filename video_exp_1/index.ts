const maximumLayoutSize = 10_000
const minimumViewportWidth = 300
const minimumViewportHeight = 390
const compactBreakpoint = 720
const videoAspectWidth = 16
const videoAspectHeight = 9
const minimumCropSize = 0.08
const duration = 12
const minimumClipDuration = 1
const mediaItemCount = 3
const mediaColumnCount = 3
const mediaRowCount = Math.ceil(mediaItemCount / mediaColumnCount)
const mediaPanelWidth = 268
const mediaHeaderHeight = 46
const mediaPadding = 12
const mediaGap = 8
const rangeCardMenuGap = 4
const timelineTrackHeight = 58
const trimHandleWidth = 18
const cropHandleRadius = 14
const animationStepMilliseconds = 6
const maximumAnimationSteps = 300

type Rectangle = {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

type Crop = {
  left: number
  top: number
  width: number
  height: number
}

type CropHandle = 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
type TimelineControl = 'start' | 'end' | 'playhead'
type SnapCorner = 'topLeft' | 'topRight' | 'bottomRight' | 'bottomLeft'

type ChromeMetrics = {
  compact: boolean
  headerHeight: number
  timelineHeight: number
  stagePadding: number
  timelinePadding: number
  timelineGap: number
  playButtonSize: number
  timeReadoutWidth: number
  cornerMargin: number
}

type PreviewLayout = {
  stage: Rectangle
  preview: Rectangle
  availableWidth: number
  availableHeight: number
}

type CropLayout = {
  normalized: Crop
  rectangle: Rectangle
  maximumLeft: number
  maximumTop: number
}

type TimelineLayout = {
  area: Rectangle
  playButton: Rectangle
  timeReadout: Rectangle
  track: Rectangle
  start: number
  end: number
  playhead: number
  startX: number
  endX: number
  playheadX: number
  maximumStart: number
  minimumEnd: number
}

type MenuLayout = {
  panel: Rectangle
  target: Rectangle
  header: Rectangle
  toggle: Rectangle
  minimumLeft: number
  maximumLeft: number
  minimumTop: number
  maximumTop: number
  horizontalTravel: number
  verticalTravel: number
  itemWidth: number
  itemHeight: number
}

type EditorLayout = {
  viewportWidth: number
  viewportHeight: number
  chrome: ChromeMetrics
  preview: PreviewLayout
  crop: CropLayout
  timeline: TimelineLayout
  menu: MenuLayout
  rangeCard: Rectangle
}

export function calculateChromeMetrics(viewportWidth: number): ChromeMetrics {
  console.assert(Number.isInteger(viewportWidth))
  console.assert(viewportWidth >= minimumViewportWidth)
  console.assert(viewportWidth <= maximumLayoutSize)

  const compact = viewportWidth < compactBreakpoint
  return {
    compact,
    headerHeight: compact ? 48 : 52,
    timelineHeight: compact ? 116 : 108,
    stagePadding: compact ? 12 : 24,
    timelinePadding: compact ? 12 : 18,
    timelineGap: compact ? 10 : 16,
    playButtonSize: 42,
    timeReadoutWidth: compact ? 76 : 92,
    cornerMargin: compact ? 12 : 16,
  }
}

export function calculatePreviewLayout(
  viewportWidth: number,
  viewportHeight: number,
): PreviewLayout {
  console.assert(Number.isInteger(viewportWidth))
  console.assert(viewportWidth >= minimumViewportWidth)
  console.assert(viewportWidth <= maximumLayoutSize)
  console.assert(Number.isInteger(viewportHeight))
  console.assert(viewportHeight >= minimumViewportHeight)
  console.assert(viewportHeight <= maximumLayoutSize)

  const chrome = calculateChromeMetrics(viewportWidth)
  const stageTop = chrome.headerHeight
  const timelineTop = viewportHeight - chrome.timelineHeight
  const stageHeight = timelineTop - stageTop
  const availableWidth = viewportWidth - chrome.stagePadding * 2
  const availableHeight = stageHeight - chrome.stagePadding * 2
  const widthAtAvailableHeight = (availableHeight * videoAspectWidth) / videoAspectHeight
  const previewWidth = Math.min(availableWidth, widthAtAvailableHeight)
  const heightAtPreviewWidth = (previewWidth * videoAspectHeight) / videoAspectWidth
  const previewHeight = Math.min(availableHeight, heightAtPreviewWidth)
  // These Math.max calls are mathematically redundant after the fit, but preserve the
  // relationship for Freerange's interval domain and guard floating-point edge cases.
  const horizontalRemainder = Math.max(0, availableWidth - previewWidth)
  const verticalRemainder = Math.max(0, availableHeight - previewHeight)
  const previewLeft = chrome.stagePadding + horizontalRemainder / 2
  const previewTop = stageTop + chrome.stagePadding + verticalRemainder / 2
  const previewRightEdge = viewportWidth - chrome.stagePadding
  const previewBottomEdge = timelineTop - chrome.stagePadding
  const previewRight = Math.min(previewRightEdge, previewLeft + previewWidth)
  const previewBottom = Math.min(previewBottomEdge, previewTop + previewHeight)

  console.assert(stageHeight >= 1)
  console.assert(availableWidth >= 1)
  console.assert(availableHeight >= 1)
  console.assert(previewWidth >= 0)
  console.assert(previewWidth <= availableWidth)
  console.assert(previewHeight >= 0)
  console.assert(previewHeight <= availableHeight)
  console.assert(horizontalRemainder >= 0)
  console.assert(verticalRemainder >= 0)
  console.assert(previewBottom <= previewBottomEdge)

  return {
    stage: {
      left: 0,
      top: stageTop,
      right: viewportWidth,
      bottom: timelineTop,
      width: viewportWidth,
      height: stageHeight,
    },
    preview: {
      left: previewLeft,
      top: previewTop,
      right: previewRight,
      bottom: previewBottom,
      width: previewWidth,
      height: previewHeight,
    },
    availableWidth,
    availableHeight,
  }
}

export function normalizeCrop(
  requestedLeft: number,
  requestedTop: number,
  requestedWidth: number,
  requestedHeight: number,
): Crop {
  const width = Math.min(1, Math.max(minimumCropSize, requestedWidth))
  const height = Math.min(1, Math.max(minimumCropSize, requestedHeight))
  const maximumLeft = Math.max(0, 1 - width)
  const maximumTop = Math.max(0, 1 - height)
  const left = Math.min(maximumLeft, Math.max(0, requestedLeft))
  const top = Math.min(maximumTop, Math.max(0, requestedTop))

  console.assert(width >= minimumCropSize)
  console.assert(width <= 1)
  console.assert(height >= minimumCropSize)
  console.assert(height <= 1)
  console.assert(left >= 0)
  console.assert(left <= maximumLeft)
  console.assert(top >= 0)
  console.assert(top <= maximumTop)
  return {left, top, width, height}
}

export function calculateCropLayout(
  previewLeft: number,
  previewTop: number,
  previewWidth: number,
  previewHeight: number,
  requestedLeft: number,
  requestedTop: number,
  requestedWidth: number,
  requestedHeight: number,
): CropLayout {
  console.assert(previewLeft >= 0)
  console.assert(previewLeft <= maximumLayoutSize)
  console.assert(previewTop >= 0)
  console.assert(previewTop <= maximumLayoutSize)
  console.assert(previewWidth >= 1)
  console.assert(previewWidth <= maximumLayoutSize)
  console.assert(previewHeight >= 1)
  console.assert(previewHeight <= maximumLayoutSize)

  const normalized = normalizeCrop(
    requestedLeft,
    requestedTop,
    requestedWidth,
    requestedHeight,
  )
  const rawWidth = normalized.width * previewWidth
  const rawHeight = normalized.height * previewHeight
  const width = Math.min(previewWidth, Math.max(0, rawWidth))
  const height = Math.min(previewHeight, Math.max(0, rawHeight))
  const maximumPixelLeft = Math.max(0, previewWidth - width)
  const maximumPixelTop = Math.max(0, previewHeight - height)
  const rawLeft = normalized.left * previewWidth
  const rawTop = normalized.top * previewHeight
  const pixelLeft = Math.min(maximumPixelLeft, Math.max(0, rawLeft))
  const pixelTop = Math.min(maximumPixelTop, Math.max(0, rawTop))
  const pixelRight = Math.min(previewWidth, pixelLeft + width)
  const pixelBottom = Math.min(previewHeight, pixelTop + height)
  const finalWidth = Math.max(0, pixelRight - pixelLeft)
  const finalHeight = Math.max(0, pixelBottom - pixelTop)
  const left = previewLeft + pixelLeft
  const top = previewTop + pixelTop
  const right = left + finalWidth
  const bottom = top + finalHeight
  const maximumLeft = 1 - normalized.width
  const maximumTop = 1 - normalized.height

  console.assert(width >= 0)
  console.assert(width <= previewWidth)
  console.assert(height >= 0)
  console.assert(height <= previewHeight)
  console.assert(pixelLeft >= 0)
  console.assert(pixelLeft <= maximumPixelLeft)
  console.assert(pixelTop >= 0)
  console.assert(pixelTop <= maximumPixelTop)
  console.assert(pixelRight <= previewWidth)
  console.assert(pixelBottom <= previewHeight)
  return {
    normalized,
    rectangle: {left, top, right, bottom, width: finalWidth, height: finalHeight},
    maximumLeft,
    maximumTop,
  }
}

export function cropAfterDrag(
  requestedCrop: Crop,
  handle: CropHandle,
  pointerDeltaX: number,
  pointerDeltaY: number,
): Crop {
  const crop = normalizeCrop(
    requestedCrop.left,
    requestedCrop.top,
    requestedCrop.width,
    requestedCrop.height,
  )
  const right = crop.left + crop.width
  const bottom = crop.top + crop.height

  switch (handle) {
    case 'move':
      return normalizeCrop(
        crop.left + pointerDeltaX,
        crop.top + pointerDeltaY,
        crop.width,
        crop.height,
      )
    case 'nw': {
      const left = Math.min(right - minimumCropSize, Math.max(0, crop.left + pointerDeltaX))
      const top = Math.min(bottom - minimumCropSize, Math.max(0, crop.top + pointerDeltaY))
      return normalizeCrop(left, top, right - left, bottom - top)
    }
    case 'n': {
      const top = Math.min(bottom - minimumCropSize, Math.max(0, crop.top + pointerDeltaY))
      return normalizeCrop(crop.left, top, crop.width, bottom - top)
    }
    case 'ne': {
      const top = Math.min(bottom - minimumCropSize, Math.max(0, crop.top + pointerDeltaY))
      const width = Math.min(1 - crop.left, Math.max(minimumCropSize, crop.width + pointerDeltaX))
      return normalizeCrop(crop.left, top, width, bottom - top)
    }
    case 'e': {
      const width = Math.min(1 - crop.left, Math.max(minimumCropSize, crop.width + pointerDeltaX))
      return normalizeCrop(crop.left, crop.top, width, crop.height)
    }
    case 'se': {
      const width = Math.min(1 - crop.left, Math.max(minimumCropSize, crop.width + pointerDeltaX))
      const height = Math.min(1 - crop.top, Math.max(minimumCropSize, crop.height + pointerDeltaY))
      return normalizeCrop(crop.left, crop.top, width, height)
    }
    case 's': {
      const height = Math.min(1 - crop.top, Math.max(minimumCropSize, crop.height + pointerDeltaY))
      return normalizeCrop(crop.left, crop.top, crop.width, height)
    }
    case 'sw': {
      const left = Math.min(right - minimumCropSize, Math.max(0, crop.left + pointerDeltaX))
      const height = Math.min(1 - crop.top, Math.max(minimumCropSize, crop.height + pointerDeltaY))
      return normalizeCrop(left, crop.top, right - left, height)
    }
    case 'w': {
      const left = Math.min(right - minimumCropSize, Math.max(0, crop.left + pointerDeltaX))
      return normalizeCrop(left, crop.top, right - left, crop.height)
    }
  }
  return crop
}

export function calculateTimelineLayout(
  viewportWidth: number,
  viewportHeight: number,
  mediaDuration: number,
  requestedStart: number,
  requestedEnd: number,
  requestedPlayhead: number,
): TimelineLayout {
  console.assert(Number.isInteger(viewportWidth))
  console.assert(viewportWidth >= minimumViewportWidth)
  console.assert(viewportWidth <= maximumLayoutSize)
  console.assert(Number.isInteger(viewportHeight))
  console.assert(viewportHeight >= minimumViewportHeight)
  console.assert(viewportHeight <= maximumLayoutSize)
  console.assert(mediaDuration >= minimumClipDuration)
  console.assert(mediaDuration <= 86_400)

  const chrome = calculateChromeMetrics(viewportWidth)
  const areaTop = viewportHeight - chrome.timelineHeight
  const controlsWidth = chrome.playButtonSize
    + chrome.timelineGap
    + chrome.timeReadoutWidth
    + chrome.timelineGap
  const requestedTrackWidth = viewportWidth - chrome.timelinePadding * 2 - controlsWidth
  const trackWidth = Math.max(1, requestedTrackWidth)
  const trackLeft = chrome.timelinePadding + controlsWidth
  const trackTop = areaTop + (chrome.timelineHeight - timelineTrackHeight) / 2
  const maximumStart = mediaDuration - minimumClipDuration
  const start = Math.min(maximumStart, Math.max(0, requestedStart))
  const minimumEnd = start + minimumClipDuration
  const end = Math.min(mediaDuration, Math.max(minimumEnd, requestedEnd))
  const playhead = Math.min(end, Math.max(start, requestedPlayhead))
  const rawStartX = (trackWidth * start) / mediaDuration
  const rawEndX = (trackWidth * end) / mediaDuration
  const rawPlayheadX = (trackWidth * playhead) / mediaDuration
  const startX = Math.min(trackWidth, Math.max(0, rawStartX))
  const endX = Math.min(trackWidth, Math.max(startX, rawEndX))
  const playheadX = Math.min(endX, Math.max(startX, rawPlayheadX))
  const playButtonTop = areaTop + (chrome.timelineHeight - chrome.playButtonSize) / 2
  const timeReadoutLeft = chrome.timelinePadding + chrome.playButtonSize + chrome.timelineGap

  console.assert(trackWidth >= 1)
  console.assert(start >= 0)
  console.assert(start <= maximumStart)
  // Freerange currently cannot prove end >= minimumEnd through the nested clamp.
  console.assert(end <= mediaDuration)
  console.assert(playhead >= start)
  console.assert(playhead <= end)
  console.assert(startX >= 0)
  console.assert(endX <= trackWidth)
  console.assert(playheadX >= startX)
  console.assert(playheadX <= endX)
  return {
    area: {
      left: 0,
      top: areaTop,
      right: viewportWidth,
      bottom: viewportHeight,
      width: viewportWidth,
      height: chrome.timelineHeight,
    },
    playButton: {
      left: chrome.timelinePadding,
      top: playButtonTop,
      right: chrome.timelinePadding + chrome.playButtonSize,
      bottom: playButtonTop + chrome.playButtonSize,
      width: chrome.playButtonSize,
      height: chrome.playButtonSize,
    },
    timeReadout: {
      left: timeReadoutLeft,
      top: areaTop,
      right: timeReadoutLeft + chrome.timeReadoutWidth,
      bottom: viewportHeight,
      width: chrome.timeReadoutWidth,
      height: chrome.timelineHeight,
    },
    track: {
      left: trackLeft,
      top: trackTop,
      right: trackLeft + trackWidth,
      bottom: trackTop + timelineTrackHeight,
      width: trackWidth,
      height: timelineTrackHeight,
    },
    start,
    end,
    playhead,
    startX,
    endX,
    playheadX,
    maximumStart,
    minimumEnd,
  }
}

export function timeFromTrackPointer(
  trackLeft: number,
  trackWidth: number,
  mediaDuration: number,
  pointerX: number,
): number {
  console.assert(trackLeft >= 0)
  console.assert(trackLeft <= maximumLayoutSize)
  console.assert(trackWidth >= 1)
  console.assert(trackWidth <= maximumLayoutSize)
  console.assert(mediaDuration >= minimumClipDuration)
  console.assert(mediaDuration <= 86_400)

  const requestedLocalX = pointerX - trackLeft
  const localX = Math.min(trackWidth, Math.max(0, requestedLocalX))
  const requestedTime = (mediaDuration * localX) / trackWidth
  const time = Math.min(mediaDuration, Math.max(0, requestedTime))

  console.assert(localX >= 0)
  console.assert(localX <= trackWidth)
  console.assert(time >= 0)
  console.assert(time <= mediaDuration)
  return time
}

export function calculateMenuLayout(
  viewportWidth: number,
  viewportHeight: number,
  expanded: boolean,
  requestedLeft: number,
  requestedTop: number,
  corner: SnapCorner,
): MenuLayout {
  console.assert(Number.isInteger(viewportWidth))
  console.assert(viewportWidth >= minimumViewportWidth)
  console.assert(viewportWidth <= maximumLayoutSize)
  console.assert(Number.isInteger(viewportHeight))
  console.assert(viewportHeight >= minimumViewportHeight)
  console.assert(viewportHeight <= maximumLayoutSize)

  const chrome = calculateChromeMetrics(viewportWidth)
  const horizontalGap = Math.min(chrome.cornerMargin, viewportWidth / 2)
  const minimumLeft = horizontalGap
  const rightEdge = Math.max(minimumLeft, viewportWidth - horizontalGap)
  const availableWidth = Math.max(0, rightEdge - minimumLeft)
  const width = Math.min(mediaPanelWidth, availableWidth)
  const verticalGap = Math.min(chrome.cornerMargin, viewportHeight / 2)
  const minimumTop = chrome.headerHeight + verticalGap
  const requestedBottomEdge = viewportHeight - chrome.timelineHeight - verticalGap
  const bottomEdge = Math.max(minimumTop, requestedBottomEdge)
  const availableHeight = Math.max(0, bottomEdge - minimumTop)
  const itemContentWidth = Math.max(1, width - mediaPadding * 2 - mediaGap * 2)
  const itemWidth = Math.max(1, itemContentWidth / mediaColumnCount)
  const itemHeightFromWidth = Math.max(1, (itemWidth * 10) / 16)
  const itemRowsHeightBudget = Math.max(
    mediaRowCount,
    availableHeight - mediaHeaderHeight - mediaPadding - mediaGap * (mediaRowCount - 1),
  )
  const itemHeight = Math.min(itemHeightFromWidth, itemRowsHeightBudget / mediaRowCount)
  const expandedHeight = mediaHeaderHeight
    + mediaPadding
    + itemHeight * mediaRowCount
    + mediaGap * (mediaRowCount - 1)
  const requestedHeight = expanded ? expandedHeight : mediaHeaderHeight
  const height = Math.min(requestedHeight, availableHeight)
  const maximumLeft = Math.max(minimumLeft, rightEdge - width)
  const maximumTop = Math.max(minimumTop, bottomEdge - height)
  const left = Math.min(maximumLeft, Math.max(minimumLeft, requestedLeft))
  const top = Math.min(maximumTop, Math.max(minimumTop, requestedTop))
  const horizontalTravel = Math.max(0, maximumLeft - minimumLeft)
  const verticalTravel = Math.max(0, maximumTop - minimumTop)
  const snapRight = corner === 'topRight' || corner === 'bottomRight'
  const snapBottom = corner === 'bottomLeft' || corner === 'bottomRight'
  const targetLeft = snapRight ? maximumLeft : minimumLeft
  const targetTop = snapBottom ? maximumTop : minimumTop
  const right = Math.min(rightEdge, left + width)
  const bottom = Math.min(bottomEdge, top + height)
  const targetRight = Math.min(rightEdge, targetLeft + width)
  const targetBottom = Math.min(bottomEdge, targetTop + height)
  const toggleSize = 30
  const toggleRight = right - 8
  const toggleLeft = Math.max(left, toggleRight - toggleSize)
  const toggleTop = top + 8
  const toggleBottom = Math.min(bottom, toggleTop + toggleSize)

  console.assert(itemWidth >= 1)
  console.assert(itemHeight >= 1)
  console.assert(width >= 0)
  console.assert(width <= availableWidth)
  console.assert(height >= 0)
  console.assert(height <= availableHeight)
  console.assert(left >= minimumLeft)
  console.assert(left <= maximumLeft)
  console.assert(top >= minimumTop)
  console.assert(top <= maximumTop)
  console.assert(right <= rightEdge)
  console.assert(bottom <= bottomEdge)
  console.assert(targetRight <= rightEdge)
  console.assert(targetBottom <= bottomEdge)
  console.assert(horizontalTravel >= 0)
  console.assert(verticalTravel >= 0)
  return {
    panel: {left, top, right, bottom, width: right - left, height: bottom - top},
    target: {
      left: targetLeft,
      top: targetTop,
      right: targetRight,
      bottom: targetBottom,
      width: targetRight - targetLeft,
      height: targetBottom - targetTop,
    },
    header: {
      left,
      top,
      right,
      bottom: Math.min(bottom, top + mediaHeaderHeight),
      width: right - left,
      height: Math.min(height, mediaHeaderHeight),
    },
    toggle: {
      left: toggleLeft,
      top: toggleTop,
      right: toggleRight,
      bottom: toggleBottom,
      width: toggleRight - toggleLeft,
      height: toggleBottom - toggleTop,
    },
    minimumLeft,
    maximumLeft,
    minimumTop,
    maximumTop,
    horizontalTravel,
    verticalTravel,
    itemWidth,
    itemHeight,
  }
}

export function mediaItemRectangle(
  panelLeft: number,
  panelTop: number,
  panelWidth: number,
  itemWidth: number,
  itemHeight: number,
  itemIndex: number,
): Rectangle {
  console.assert(panelLeft >= 0)
  console.assert(panelLeft <= maximumLayoutSize)
  console.assert(panelTop >= 0)
  console.assert(panelTop <= maximumLayoutSize)
  console.assert(panelWidth >= 1)
  console.assert(panelWidth <= mediaPanelWidth)
  console.assert(itemWidth >= 1)
  console.assert(itemWidth <= mediaPanelWidth)
  console.assert(itemHeight >= 1)
  console.assert(itemHeight <= mediaPanelWidth)
  console.assert(Number.isInteger(itemIndex))
  console.assert(itemIndex >= 0)
  console.assert(itemIndex < mediaItemCount)
  const column = itemIndex % mediaColumnCount
  const row = Math.floor(itemIndex / mediaColumnCount)
  const requestedLeft = panelLeft + mediaPadding + column * (itemWidth + mediaGap)
  const contentRight = panelLeft + Math.max(0, panelWidth - mediaPadding)
  const left = Math.min(contentRight, requestedLeft)
  const top = panelTop + mediaHeaderHeight + row * (itemHeight + mediaGap)
  const right = Math.min(contentRight, left + itemWidth)
  const bottom = top + itemHeight
  const width = right - left

  console.assert(column >= 0)
  console.assert(column < mediaColumnCount)
  console.assert(row >= 0)
  console.assert(row < mediaRowCount)
  console.assert(right >= left)
  return {left, top, right, bottom, width, height: itemHeight}
}

export function rectangleContainsPoint(
  rectangle: Rectangle,
  pointX: number,
  pointY: number,
): boolean {
  return pointX >= rectangle.left
    && pointX <= rectangle.right
    && pointY >= rectangle.top
    && pointY <= rectangle.bottom
}

export function calculateEditorLayout(
  viewportWidth: number,
  viewportHeight: number,
  crop: Crop,
  trimStart: number,
  trimEnd: number,
  playhead: number,
  menuExpanded: boolean,
  menuLeft: number,
  menuTop: number,
  menuCorner: SnapCorner,
): EditorLayout {
  console.assert(Number.isInteger(viewportWidth))
  console.assert(viewportWidth >= minimumViewportWidth)
  console.assert(viewportWidth <= maximumLayoutSize)
  console.assert(Number.isInteger(viewportHeight))
  console.assert(viewportHeight >= minimumViewportHeight)
  console.assert(viewportHeight <= maximumLayoutSize)

  const chrome = calculateChromeMetrics(viewportWidth)
  const preview = calculatePreviewLayout(viewportWidth, viewportHeight)
  const cropLayout = calculateCropLayout(
    preview.preview.left,
    preview.preview.top,
    preview.preview.width,
    preview.preview.height,
    crop.left,
    crop.top,
    crop.width,
    crop.height,
  )
  const timeline = calculateTimelineLayout(
    viewportWidth,
    viewportHeight,
    duration,
    trimStart,
    trimEnd,
    playhead,
  )
  const menu = calculateMenuLayout(
    viewportWidth,
    viewportHeight,
    menuExpanded,
    menuLeft,
    menuTop,
    menuCorner,
  )
  const rangeCardHeight = chrome.compact ? 100 : viewportHeight < 600 ? 104 : 88
  let rangeCardLeft = chrome.stagePadding
  let rangeCardWidth = Math.min(760, viewportWidth - chrome.stagePadding * 2)
  const cardMenuGap = rangeCardMenuGap
  const minimumRangeCardTop = chrome.headerHeight + cardMenuGap
  const maximumRangeCardBottom = timeline.area.top - cardMenuGap
  const maximumRangeCardTop = maximumRangeCardBottom - rangeCardHeight
  let rangeCardTop = maximumRangeCardTop
  let rangeCardBottom = rangeCardTop + rangeCardHeight
  const menuOverlapsRangeCard = menu.panel.top < rangeCardBottom && menu.panel.bottom > rangeCardTop
  if (menuOverlapsRangeCard) {
    // Stable corner destinations preserve rangeCardMenuGap. During direct dragging, a
    // centered panel may temporarily cross the card when neither side has enough room.
    const leftSpace = Math.max(1, menu.panel.left - cardMenuGap - chrome.stagePadding)
    const rightCardLeft = menu.panel.right + cardMenuGap
    const rightSpace = Math.max(1, viewportWidth - chrome.stagePadding - rightCardLeft)
    const sideFitsWithoutNarrowing = Math.max(leftSpace, rightSpace) >= rangeCardWidth
    const aboveMenuTop = menu.panel.top - cardMenuGap - rangeCardHeight
    const belowMenuTop = menu.panel.bottom + cardMenuGap
    const aboveMenuFits = aboveMenuTop >= minimumRangeCardTop
    const belowMenuFits = belowMenuTop <= maximumRangeCardTop
    if (sideFitsWithoutNarrowing) {
      if (leftSpace >= rightSpace) {
        rangeCardWidth = Math.min(rangeCardWidth, leftSpace)
      } else {
        rangeCardLeft = rightCardLeft
        rangeCardWidth = Math.min(rangeCardWidth, rightSpace)
      }
    } else if (aboveMenuFits || belowMenuFits) {
      rangeCardTop = aboveMenuFits ? aboveMenuTop : belowMenuTop
      rangeCardBottom = rangeCardTop + rangeCardHeight
    } else {
      const minimumSideCardWidth = 240
      if (Math.max(leftSpace, rightSpace) >= minimumSideCardWidth) {
        if (leftSpace >= rightSpace) {
          rangeCardWidth = Math.min(rangeCardWidth, leftSpace)
        } else {
          rangeCardLeft = rightCardLeft
          rangeCardWidth = Math.min(rangeCardWidth, rightSpace)
        }
      }
    }
  }

  const rangeCardRight = rangeCardLeft + rangeCardWidth
  runtimeAssert(rangeCardLeft >= 0, 'Range card must stay inside the left viewport edge')
  runtimeAssert(rangeCardRight <= viewportWidth, 'Range card must stay inside the right viewport edge')
  runtimeAssert(rangeCardTop >= minimumRangeCardTop, 'Range card must stay below the header')
  runtimeAssert(rangeCardBottom <= maximumRangeCardBottom, 'Range card must stay above the timeline')

  return {
    viewportWidth,
    viewportHeight,
    chrome,
    preview,
    crop: cropLayout,
    timeline,
    menu,
    rangeCard: {
      left: rangeCardLeft,
      top: rangeCardTop,
      right: rangeCardRight,
      bottom: rangeCardBottom,
      width: rangeCardWidth,
      height: rangeCardHeight,
    },
  }
}

export function cropHandleAt(
  crop: Rectangle,
  pointX: number,
  pointY: number,
): CropHandle | null {
  const hitLeft = Math.abs(pointX - crop.left) <= cropHandleRadius
  const hitRight = Math.abs(pointX - crop.right) <= cropHandleRadius
  const hitTop = Math.abs(pointY - crop.top) <= cropHandleRadius
  const hitBottom = Math.abs(pointY - crop.bottom) <= cropHandleRadius
  const withinHorizontalSpan = pointX >= crop.left - cropHandleRadius
    && pointX <= crop.right + cropHandleRadius
  const withinVerticalSpan = pointY >= crop.top - cropHandleRadius
    && pointY <= crop.bottom + cropHandleRadius

  if (hitLeft && hitTop) return 'nw'
  if (hitRight && hitTop) return 'ne'
  if (hitRight && hitBottom) return 'se'
  if (hitLeft && hitBottom) return 'sw'
  if (hitTop && withinHorizontalSpan) return 'n'
  if (hitRight && withinVerticalSpan) return 'e'
  if (hitBottom && withinHorizontalSpan) return 's'
  if (hitLeft && withinVerticalSpan) return 'w'
  return rectangleContainsPoint(crop, pointX, pointY) ? 'move' : null
}

export function timelineControlAt(
  timeline: TimelineLayout,
  pointX: number,
): TimelineControl {
  const localX = pointX - timeline.track.left
  const startDistance = Math.abs(localX - timeline.startX)
  const endDistance = Math.abs(localX - timeline.endX)
  if (startDistance <= trimHandleWidth || endDistance <= trimHandleWidth) {
    return startDistance <= endDistance ? 'start' : 'end'
  }
  return 'playhead'
}

export function cornerForPanel(
  panel: Rectangle,
  viewportWidth: number,
  viewportHeight: number,
): SnapCorner {
  const centerX = panel.left + panel.width / 2
  const centerY = panel.top + panel.height / 2
  const left = centerX < viewportWidth / 2
  const top = centerY < viewportHeight / 2
  if (top) return left ? 'topLeft' : 'topRight'
  return left ? 'bottomLeft' : 'bottomRight'
}

type PointerPhase = 'down' | 'move' | 'up' | 'cancel'
type KeyboardTarget =
  | 'global'
  | 'nativeButton'
  | 'playButton'
  | 'menuButton'
  | 'mediaButton'
  | 'crop'
  | 'trimStart'
  | 'trimEnd'
  | 'playhead'

type RawInput =
  | {
    kind: 'pointer'
    phase: PointerPhase
    pointerId: number
    button: number
    pageX: number
    pageY: number
    clientX: number
    clientY: number
    timeStamp: number
  }
  | {
    kind: 'key'
    key: string
    shiftKey: boolean
    repeat: boolean
    target: KeyboardTarget
    itemIndex: number
    timeStamp: number
  }
  | {kind: 'activate'; control: 'play' | 'menu'; timeStamp: number}
  | {kind: 'selectMedia'; itemIndex: number; timeStamp: number}
  | {kind: 'cancelAll'; timeStamp: number}

type Drag =
  | {
    kind: 'crop'
    pointerId: number
    handle: CropHandle
    pointerDownX: number
    pointerDownY: number
    cropAtPointerDown: Crop
  }
  | {kind: 'timeline'; pointerId: number; control: TimelineControl}
  | {kind: 'menu'; pointerId: number; offsetX: number; offsetY: number}

type Spring = {position: number; destination: number; velocity: number}

type AppState = {
  crop: Crop
  trimStart: number
  trimEnd: number
  time: number
  playing: boolean
  selectedClip: number
  menuExpanded: boolean
  menuCorner: SnapCorner
  menuX: Spring
  menuY: Spring
  menuRecentlyReleased: boolean
  drag: Drag | null
  pointerX: number
  pointerY: number
  inputs: RawInput[]
  animatedUntilTime: number | null
  previousPlaybackFrameTime: number | null
}

// Freerange verifies the pure geometry above. The DOM, mutable event queue, canvas,
// and animation adapter below are deliberately covered by runtime and browser checks.
function readViewport(): {width: number; height: number} {
  const requestedWidth = document.documentElement.clientWidth
  const requestedHeight = document.documentElement.clientHeight
  // The proof domain is explicit. Normal phone, tablet, desktop, and short landscape
  // viewports use their real dimensions; only smaller diagnostic windows use the floor.
  const width = Math.min(maximumLayoutSize, Math.max(minimumViewportWidth, requestedWidth))
  const height = Math.min(maximumLayoutSize, Math.max(minimumViewportHeight, requestedHeight))
  return {width, height}
}

function spring(position: number): Spring {
  return {position, destination: position, velocity: 0}
}

const initialViewport = readViewport()
const initialMenuExpanded = initialViewport.width >= 340 || initialViewport.height >= 500
const initialMenu = calculateMenuLayout(
  initialViewport.width,
  initialViewport.height,
  initialMenuExpanded,
  0,
  0,
  'topRight',
)

const state: AppState = {
  crop: {left: 0.15, top: 0.12, width: 0.7, height: 0.76},
  trimStart: 1.2,
  trimEnd: 9.8,
  time: 4.25,
  playing: false,
  selectedClip: 0,
  menuExpanded: initialMenuExpanded,
  menuCorner: 'topRight',
  menuX: spring(initialMenu.target.left),
  menuY: spring(initialMenu.target.top),
  menuRecentlyReleased: false,
  drag: null,
  pointerX: -1,
  pointerY: -1,
  inputs: [],
  animatedUntilTime: null,
  previousPlaybackFrameTime: null,
}

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id)
  if (!(element instanceof HTMLElement)) throw new Error(`Missing HTMLElement #${id}`)
  return element
}

function requiredCanvas(id: string): HTMLCanvasElement {
  const element = document.getElementById(id)
  if (!(element instanceof HTMLCanvasElement)) throw new Error(`Missing canvas #${id}`)
  return element
}

function requiredContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d')
  if (context == null) throw new Error(`Missing 2D context for #${canvas.id}`)
  return context
}

type DomCache = {
  app: HTMLElement
  header: HTMLElement
  metricReadout: HTMLElement
  stage: HTMLElement
  previewShell: HTMLElement
  preview: HTMLCanvasElement
  previewContext: CanvasRenderingContext2D
  cropOverlay: HTMLElement
  rangeCard: HTMLElement
  timelineArea: HTMLElement
  playButton: HTMLElement
  timeReadout: HTMLElement
  currentTime: HTMLElement
  totalTime: HTMLElement
  timeline: HTMLElement
  filmstrip: HTMLCanvasElement
  filmstripContext: CanvasRenderingContext2D
  leftShade: HTMLElement
  rightShade: HTMLElement
  trimSelection: HTMLElement
  trimStartHandle: HTMLElement
  trimEndHandle: HTMLElement
  playhead: HTMLElement
  scrubBubble: HTMLElement
  mediaPanel: HTMLElement
  mediaHeader: HTMLElement
  mediaToggle: HTMLElement
  mediaToggleGlyph: HTMLElement
  mediaItems: HTMLElement[]
}

const mediaItems = Array.from(document.querySelectorAll<HTMLElement>('.mediaItem'))
if (mediaItems.length !== mediaItemCount) throw new Error('Expected three permanent media item nodes')
const previewCanvas = requiredCanvas('preview')
const filmstripCanvas = requiredCanvas('filmstrip')

// Every entry has the lifetime of the app. Stateful canvases are never detached or recreated.
const domCache: DomCache = {
  app: requiredElement('app'),
  header: requiredElement('header'),
  metricReadout: requiredElement('metricReadout'),
  stage: requiredElement('stage'),
  previewShell: requiredElement('previewShell'),
  preview: previewCanvas,
  previewContext: requiredContext(previewCanvas),
  cropOverlay: requiredElement('cropOverlay'),
  rangeCard: requiredElement('rangeCard'),
  timelineArea: requiredElement('timelineArea'),
  playButton: requiredElement('playButton'),
  timeReadout: requiredElement('timeReadout'),
  currentTime: requiredElement('currentTime'),
  totalTime: requiredElement('totalTime'),
  timeline: requiredElement('timeline'),
  filmstrip: filmstripCanvas,
  filmstripContext: requiredContext(filmstripCanvas),
  leftShade: requiredElement('leftShade'),
  rightShade: requiredElement('rightShade'),
  trimSelection: requiredElement('trimSelection'),
  trimStartHandle: requiredElement('trimStartHandle'),
  trimEndHandle: requiredElement('trimEndHandle'),
  playhead: requiredElement('playhead'),
  scrubBubble: requiredElement('scrubBubble'),
  mediaPanel: requiredElement('mediaPanel'),
  mediaHeader: requiredElement('mediaHeader'),
  mediaToggle: requiredElement('mediaToggle'),
  mediaToggleGlyph: requiredElement('mediaToggleGlyph'),
  mediaItems,
}

type PaintCache = {
  filmstripWidth: number
  filmstripHeight: number
  filmstripScale: number
  selectedClip: number
}

// Canvas rasterization is genuinely expensive; cache only the inputs of the static filmstrip paint.
const paintCache: PaintCache = {
  filmstripWidth: -1,
  filmstripHeight: -1,
  filmstripScale: -1,
  selectedClip: -1,
}

let scheduledAnimationFrame: number | null = null

function scheduleRender(): void {
  if (scheduledAnimationFrame != null) return
  scheduledAnimationFrame = requestAnimationFrame(function renderAndMaybeScheduleAnotherRender(now) {
    scheduledAnimationFrame = null
    if (render(now)) scheduleRender()
  })
}

function queuePointerInput(phase: PointerPhase, event: PointerEvent): void {
  state.inputs.push({
    kind: 'pointer',
    phase,
    pointerId: event.pointerId,
    button: event.button,
    pageX: event.pageX,
    pageY: event.pageY,
    clientX: event.clientX,
    clientY: event.clientY,
    timeStamp: event.timeStamp,
  })
  scheduleRender()
}

function handlePointerDown(event: PointerEvent): void {
  queuePointerInput('down', event)
}

function handlePointerMove(event: PointerEvent): void {
  queuePointerInput('move', event)
}

function handlePointerUp(event: PointerEvent): void {
  queuePointerInput('up', event)
}

function handlePointerCancel(event: PointerEvent): void {
  queuePointerInput('cancel', event)
}

function keyboardTargetForEventTarget(target: EventTarget | null): KeyboardTarget {
  if (target === domCache.cropOverlay) return 'crop'
  if (target === domCache.trimStartHandle) return 'trimStart'
  if (target === domCache.trimEndHandle) return 'trimEnd'
  if (target === domCache.playhead) return 'playhead'
  if (target === domCache.playButton) return 'playButton'
  if (target === domCache.mediaToggle) return 'menuButton'
  for (const mediaItem of domCache.mediaItems) {
    if (target === mediaItem) return 'mediaButton'
  }
  if (target instanceof HTMLButtonElement) return 'nativeButton'
  return 'global'
}

function keyboardMediaIndexForEventTarget(target: EventTarget | null): number {
  for (let itemIndex = 0; itemIndex < domCache.mediaItems.length; itemIndex++) {
    if (target === domCache.mediaItems[itemIndex]) return itemIndex
  }
  return -1
}

function handleKeyDown(event: KeyboardEvent): void {
  const target = keyboardTargetForEventTarget(event.target)
  const activationKey = event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar'
  const semanticButton = target === 'playButton' || target === 'menuButton' || target === 'mediaButton'
  if (activationKey && semanticButton) event.preventDefault()
  state.inputs.push({
    kind: 'key',
    key: event.key,
    shiftKey: event.shiftKey,
    repeat: event.repeat,
    target,
    itemIndex: keyboardMediaIndexForEventTarget(event.target),
    timeStamp: event.timeStamp,
  })
  scheduleRender()
}

function queueActivation(control: 'play' | 'menu', event: MouseEvent): void {
  state.inputs.push({kind: 'activate', control, timeStamp: event.timeStamp})
  scheduleRender()
}

function handlePlayActivation(event: MouseEvent): void {
  queueActivation('play', event)
}

function handleMenuActivation(event: MouseEvent): void {
  queueActivation('menu', event)
}

function queueMediaSelection(itemIndex: number, event: MouseEvent): void {
  state.inputs.push({kind: 'selectMedia', itemIndex, timeStamp: event.timeStamp})
  scheduleRender()
}

function handleWindowBlur(event: FocusEvent): void {
  state.inputs.push({kind: 'cancelAll', timeStamp: event.timeStamp})
  scheduleRender()
}

function calculateStateLayout(viewport: {width: number; height: number}): EditorLayout {
  console.assert(Number.isInteger(viewport.width))
  console.assert(viewport.width >= minimumViewportWidth)
  console.assert(viewport.width <= maximumLayoutSize)
  console.assert(Number.isInteger(viewport.height))
  console.assert(viewport.height >= minimumViewportHeight)
  console.assert(viewport.height <= maximumLayoutSize)

  return calculateEditorLayout(
    viewport.width,
    viewport.height,
    state.crop,
    state.trimStart,
    state.trimEnd,
    state.time,
    state.menuExpanded,
    state.menuX.position,
    state.menuY.position,
    state.menuCorner,
  )
}

function commitTimeline(timeline: TimelineLayout): void {
  state.trimStart = timeline.start
  state.trimEnd = timeline.end
  state.time = timeline.playhead
}

function setTimelineFromPointer(
  layout: EditorLayout,
  control: TimelineControl,
  pointerX: number,
): void {
  const requestedTime = timeFromTrackPointer(
    layout.timeline.track.left,
    layout.timeline.track.width,
    duration,
    pointerX,
  )
  switch (control) {
    case 'start':
      commitTimeline(calculateTimelineLayout(
        layout.viewportWidth,
        layout.viewportHeight,
        duration,
        requestedTime,
        state.trimEnd,
        state.time,
      ))
      return
    case 'end':
      commitTimeline(calculateTimelineLayout(
        layout.viewportWidth,
        layout.viewportHeight,
        duration,
        state.trimStart,
        requestedTime,
        state.time,
      ))
      return
    case 'playhead':
      commitTimeline(calculateTimelineLayout(
        layout.viewportWidth,
        layout.viewportHeight,
        duration,
        state.trimStart,
        state.trimEnd,
        requestedTime,
      ))
      return
  }
}

function mediaItemAt(layout: EditorLayout, pointX: number, pointY: number): number | null {
  if (!state.menuExpanded) return null
  for (let itemIndex = 0; itemIndex < mediaItemCount; itemIndex++) {
    const item = mediaItemRectangle(
      layout.menu.panel.left,
      layout.menu.panel.top,
      layout.menu.panel.width,
      layout.menu.itemWidth,
      layout.menu.itemHeight,
      itemIndex,
    )
    if (rectangleContainsPoint(item, pointX, pointY)) return itemIndex
  }
  return null
}

function processPointerDown(layout: EditorLayout, input: Extract<RawInput, {kind: 'pointer'}>): void {
  if (input.button !== 0) return

  if (rectangleContainsPoint(layout.menu.toggle, input.pageX, input.pageY)) {
    return
  }

  const selectedMediaItem = mediaItemAt(layout, input.pageX, input.pageY)
  if (selectedMediaItem != null) {
    return
  }

  if (rectangleContainsPoint(layout.menu.header, input.pageX, input.pageY)) {
    state.drag = {
      kind: 'menu',
      pointerId: input.pointerId,
      offsetX: input.pageX - layout.menu.panel.left,
      offsetY: input.pageY - layout.menu.panel.top,
    }
    state.menuX.position = layout.menu.panel.left
    state.menuX.destination = layout.menu.panel.left
    state.menuX.velocity = 0
    state.menuY.position = layout.menu.panel.top
    state.menuY.destination = layout.menu.panel.top
    state.menuY.velocity = 0
    state.menuRecentlyReleased = false
    return
  }

  if (rectangleContainsPoint(layout.timeline.playButton, input.pageX, input.pageY)) {
    return
  }

  const timelineHitRectangle = {
    left: layout.timeline.track.left - trimHandleWidth,
    top: layout.timeline.track.top - 8,
    right: layout.timeline.track.right + trimHandleWidth,
    bottom: layout.timeline.track.bottom + 8,
    width: layout.timeline.track.width + trimHandleWidth * 2,
    height: layout.timeline.track.height + 16,
  }
  if (rectangleContainsPoint(timelineHitRectangle, input.pageX, input.pageY)) {
    const control = timelineControlAt(layout.timeline, input.pageX)
    state.drag = {kind: 'timeline', pointerId: input.pointerId, control}
    state.playing = false
    state.previousPlaybackFrameTime = null
    setTimelineFromPointer(layout, control, input.pageX)
    return
  }

  const cropHandle = cropHandleAt(layout.crop.rectangle, input.pageX, input.pageY)
  if (cropHandle != null) {
    state.drag = {
      kind: 'crop',
      pointerId: input.pointerId,
      handle: cropHandle,
      pointerDownX: input.pageX,
      pointerDownY: input.pageY,
      cropAtPointerDown: {
        left: layout.crop.normalized.left,
        top: layout.crop.normalized.top,
        width: layout.crop.normalized.width,
        height: layout.crop.normalized.height,
      },
    }
  }
}

function processPointerMove(layout: EditorLayout, input: Extract<RawInput, {kind: 'pointer'}>): void {
  const drag = state.drag
  if (drag == null || drag.pointerId !== input.pointerId) return

  switch (drag.kind) {
    case 'menu': {
      const requestedLeft = input.pageX - drag.offsetX
      const requestedTop = input.pageY - drag.offsetY
      const draggedMenu = calculateMenuLayout(
        layout.viewportWidth,
        layout.viewportHeight,
        state.menuExpanded,
        requestedLeft,
        requestedTop,
        state.menuCorner,
      )
      state.menuX.position = draggedMenu.panel.left
      state.menuX.destination = draggedMenu.panel.left
      state.menuX.velocity = 0
      state.menuY.position = draggedMenu.panel.top
      state.menuY.destination = draggedMenu.panel.top
      state.menuY.velocity = 0
      return
    }
    case 'crop': {
      const pointerDeltaX = (input.pageX - drag.pointerDownX) / layout.preview.preview.width
      const pointerDeltaY = (input.pageY - drag.pointerDownY) / layout.preview.preview.height
      state.crop = cropAfterDrag(
        drag.cropAtPointerDown,
        drag.handle,
        pointerDeltaX,
        pointerDeltaY,
      )
      return
    }
    case 'timeline':
      setTimelineFromPointer(layout, drag.control, input.pageX)
  }
}

function processPointerEnd(layout: EditorLayout, input: Extract<RawInput, {kind: 'pointer'}>): void {
  const drag = state.drag
  if (drag == null || drag.pointerId !== input.pointerId) return
  if (drag.kind === 'menu') {
    state.menuCorner = cornerForPanel(
      layout.menu.panel,
      layout.viewportWidth,
      layout.viewportHeight,
    )
    state.menuRecentlyReleased = true
  }
  state.drag = null
}

function cycleCorner(corner: SnapCorner): SnapCorner {
  switch (corner) {
    case 'topLeft': return 'topRight'
    case 'topRight': return 'bottomRight'
    case 'bottomRight': return 'bottomLeft'
    case 'bottomLeft': return 'topLeft'
  }
  return corner
}

function processCropKey(input: Extract<RawInput, {kind: 'key'}>): void {
  const cropStep = 0.01
  if (input.shiftKey) {
    switch (input.key) {
      case 'ArrowLeft':
        state.crop = cropAfterDrag(state.crop, 'e', -cropStep, 0)
        return
      case 'ArrowRight':
        state.crop = cropAfterDrag(state.crop, 'e', cropStep, 0)
        return
      case 'ArrowUp':
        state.crop = cropAfterDrag(state.crop, 's', 0, -cropStep)
        return
      case 'ArrowDown':
        state.crop = cropAfterDrag(state.crop, 's', 0, cropStep)
        return
      default:
        return
    }
  }

  switch (input.key) {
    case 'ArrowLeft':
      state.crop = cropAfterDrag(state.crop, 'move', -cropStep, 0)
      return
    case 'ArrowRight':
      state.crop = cropAfterDrag(state.crop, 'move', cropStep, 0)
      return
    case 'ArrowUp':
      state.crop = cropAfterDrag(state.crop, 'move', 0, -cropStep)
      return
    case 'ArrowDown':
      state.crop = cropAfterDrag(state.crop, 'move', 0, cropStep)
      return
    default:
      return
  }
}

function processTimelineKey(
  layout: EditorLayout,
  input: Extract<RawInput, {kind: 'key'}>,
  control: TimelineControl,
): void {
  if (input.key !== 'ArrowLeft' && input.key !== 'ArrowRight') return
  const direction = input.key === 'ArrowLeft' ? -1 : 1
  const timeStep = input.shiftKey ? 1 : 0.25
  const delta = direction * timeStep

  switch (control) {
    case 'start': {
      const maximumKeyboardStart = Math.max(0, state.trimEnd - minimumClipDuration)
      commitTimeline(calculateTimelineLayout(
        layout.viewportWidth,
        layout.viewportHeight,
        duration,
        Math.min(maximumKeyboardStart, state.trimStart + delta),
        state.trimEnd,
        state.time,
      ))
      return
    }
    case 'end':
      commitTimeline(calculateTimelineLayout(
        layout.viewportWidth,
        layout.viewportHeight,
        duration,
        state.trimStart,
        state.trimEnd + delta,
        state.time,
      ))
      return
    case 'playhead':
      commitTimeline(calculateTimelineLayout(
        layout.viewportWidth,
        layout.viewportHeight,
        duration,
        state.trimStart,
        state.trimEnd,
        state.time + delta,
      ))
      return
  }
}

function processKey(layout: EditorLayout, input: Extract<RawInput, {kind: 'key'}>): void {
  const activationKey = input.key === 'Enter' || input.key === ' ' || input.key === 'Spacebar'
  if (input.target === 'playButton') {
    if (activationKey && !input.repeat) {
      state.playing = !state.playing
      state.previousPlaybackFrameTime = null
    }
    return
  }
  if (input.target === 'menuButton') {
    if (activationKey && !input.repeat) {
      state.menuExpanded = !state.menuExpanded
      state.menuRecentlyReleased = true
    }
    return
  }
  if (input.target === 'mediaButton') {
    if (activationKey && !input.repeat) {
      if (!Number.isInteger(input.itemIndex) || input.itemIndex < 0 || input.itemIndex >= mediaItemCount) {
        throw new Error(`Invalid keyboard media item ${input.itemIndex}`)
      }
      state.selectedClip = input.itemIndex
    }
    return
  }
  if (input.target === 'nativeButton') return
  if (input.target === 'crop') {
    processCropKey(input)
    return
  }
  if (input.target === 'trimStart') {
    processTimelineKey(layout, input, 'start')
    return
  }
  if (input.target === 'trimEnd') {
    processTimelineKey(layout, input, 'end')
    return
  }
  if (input.target === 'playhead') {
    processTimelineKey(layout, input, 'playhead')
    return
  }

  const timeStep = input.shiftKey ? 1 : 0.25
  switch (input.key) {
    case ' ':
    case 'Spacebar':
      if (input.repeat) return
      state.playing = !state.playing
      state.previousPlaybackFrameTime = null
      return
    case 'm':
    case 'M':
      if (input.repeat) return
      state.menuExpanded = !state.menuExpanded
      state.menuRecentlyReleased = true
      return
    case 'c':
    case 'C':
      if (input.repeat) return
      state.menuCorner = cycleCorner(state.menuCorner)
      state.menuRecentlyReleased = true
      return
    case 'ArrowLeft':
      commitTimeline(calculateTimelineLayout(
        layout.viewportWidth,
        layout.viewportHeight,
        duration,
        state.trimStart,
        state.trimEnd,
        state.time - timeStep,
      ))
      return
    case 'ArrowRight':
      commitTimeline(calculateTimelineLayout(
        layout.viewportWidth,
        layout.viewportHeight,
        duration,
        state.trimStart,
        state.trimEnd,
        state.time + timeStep,
      ))
      return
    case '[':
      commitTimeline(calculateTimelineLayout(
        layout.viewportWidth,
        layout.viewportHeight,
        duration,
        state.trimStart - timeStep,
        state.trimEnd,
        state.time,
      ))
      return
    case ']':
      commitTimeline(calculateTimelineLayout(
        layout.viewportWidth,
        layout.viewportHeight,
        duration,
        state.trimStart,
        state.trimEnd + timeStep,
        state.time,
      ))
      return
    case 'Escape':
      state.drag = null
      return
    default:
      return
  }
}

function processInput(layout: EditorLayout, input: RawInput): void {
  switch (input.kind) {
    case 'pointer':
      state.pointerX = input.clientX
      state.pointerY = input.clientY
      switch (input.phase) {
        case 'down':
          processPointerDown(layout, input)
          return
        case 'move':
          processPointerMove(layout, input)
          return
        case 'up':
          processPointerEnd(layout, input)
          return
        case 'cancel':
          processPointerEnd(layout, input)
          return
      }
      return
    case 'key':
      processKey(layout, input)
      return
    case 'activate':
      switch (input.control) {
        case 'play':
          state.playing = !state.playing
          state.previousPlaybackFrameTime = null
          return
        case 'menu':
          state.menuExpanded = !state.menuExpanded
          state.menuRecentlyReleased = true
          return
      }
    case 'selectMedia':
      if (!Number.isInteger(input.itemIndex) || input.itemIndex < 0 || input.itemIndex >= mediaItemCount) {
        throw new Error(`Invalid media item ${input.itemIndex}`)
      }
      state.selectedClip = input.itemIndex
      return
    case 'cancelAll':
      if (state.drag != null && state.drag.kind === 'menu') {
        state.menuCorner = cornerForPanel(
          layout.menu.panel,
          layout.viewportWidth,
          layout.viewportHeight,
        )
        state.menuRecentlyReleased = true
      }
      state.drag = null
  }
}

function springStep(config: Spring): void {
  const seconds = animationStepMilliseconds / 1000
  const stiffness = 333
  const damping = 33
  const springForce = -stiffness * (config.position - config.destination)
  const dampingForce = -damping * config.velocity
  const acceleration = springForce + dampingForce
  const velocity = config.velocity + acceleration * seconds
  config.velocity = velocity
  config.position += velocity * seconds
}

function springMostlyDone(config: Spring): boolean {
  return Math.abs(config.velocity) < 0.01
    && Math.abs(config.destination - config.position) < 0.01
}

function springGoToEnd(config: Spring): void {
  config.position = config.destination
  config.velocity = 0
}

function advanceMenuAnimation(now: number, layout: EditorLayout): boolean {
  if (state.drag != null && state.drag.kind === 'menu') {
    state.animatedUntilTime = null
    return false
  }

  state.menuX.position = layout.menu.panel.left
  state.menuY.position = layout.menu.panel.top
  state.menuX.destination = layout.menu.target.left
  state.menuY.destination = layout.menu.target.top
  let animatedUntilTime = state.animatedUntilTime ?? now
  const requestedSteps = Math.floor((now - animatedUntilTime) / animationStepMilliseconds)
  const steps = Math.min(maximumAnimationSteps, Math.max(0, requestedSteps))
  for (let step = 0; step < steps; step++) {
    springStep(state.menuX)
    springStep(state.menuY)
  }
  animatedUntilTime += steps * animationStepMilliseconds

  const animationDone = springMostlyDone(state.menuX) && springMostlyDone(state.menuY)
  if (animationDone) {
    springGoToEnd(state.menuX)
    springGoToEnd(state.menuY)
    state.animatedUntilTime = null
    state.menuRecentlyReleased = false
    return false
  }
  state.animatedUntilTime = animatedUntilTime
  return true
}

function advancePlayback(now: number): boolean {
  if (!state.playing) {
    state.previousPlaybackFrameTime = null
    return false
  }

  const previousFrameTime = state.previousPlaybackFrameTime
  state.previousPlaybackFrameTime = now
  if (previousFrameTime == null) return true
  const elapsedSeconds = Math.min(0.1, Math.max(0, (now - previousFrameTime) / 1000))
  const clipDuration = Math.max(minimumClipDuration, state.trimEnd - state.trimStart)
  const requestedTime = state.time + elapsedSeconds
  state.time = requestedTime >= state.trimEnd
    ? state.trimStart + ((requestedTime - state.trimStart) % clipDuration)
    : requestedTime
  return true
}

function cursorForLayout(layout: EditorLayout): string {
  const drag = state.drag
  if (drag != null) {
    switch (drag.kind) {
      case 'menu': return 'grabbing'
      case 'timeline': return 'ew-resize'
      case 'crop':
        switch (drag.handle) {
          case 'move': return 'move'
          case 'n': return 'ns-resize'
          case 's': return 'ns-resize'
          case 'e': return 'ew-resize'
          case 'w': return 'ew-resize'
          case 'nw': return 'nwse-resize'
          case 'se': return 'nwse-resize'
          case 'ne': return 'nesw-resize'
          case 'sw': return 'nesw-resize'
        }
        return 'default'
    }
  }

  if (rectangleContainsPoint(layout.menu.toggle, state.pointerX, state.pointerY)) return 'pointer'
  if (mediaItemAt(layout, state.pointerX, state.pointerY) != null) return 'pointer'
  if (rectangleContainsPoint(layout.menu.header, state.pointerX, state.pointerY)) return 'grab'
  if (rectangleContainsPoint(layout.timeline.playButton, state.pointerX, state.pointerY)) return 'pointer'
  if (rectangleContainsPoint(layout.timeline.track, state.pointerX, state.pointerY)) return 'ew-resize'

  const cropHandle = cropHandleAt(layout.crop.rectangle, state.pointerX, state.pointerY)
  switch (cropHandle) {
    case 'move': return 'move'
    case 'n': return 'ns-resize'
    case 's': return 'ns-resize'
    case 'e': return 'ew-resize'
    case 'w': return 'ew-resize'
    case 'nw': return 'nwse-resize'
    case 'se': return 'nwse-resize'
    case 'ne': return 'nesw-resize'
    case 'sw': return 'nesw-resize'
    case null: return 'default'
  }
}

function setRectangle(
  element: HTMLElement,
  rectangle: Rectangle,
  originLeft: number,
  originTop: number,
): void {
  const left = rectangle.left - originLeft
  const top = rectangle.top - originTop
  element.style.transform = `translate3d(${left}px, ${top}px, 0)`
  element.style.width = `${Math.max(0, rectangle.width)}px`
  element.style.height = `${Math.max(0, rectangle.height)}px`
}

function formatTime(time: number): string {
  const minutes = Math.floor(time / 60)
  const seconds = time - minutes * 60
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds.toFixed(2)}`
}

function formatMetric(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function formatNormalizedMetric(value: number): string {
  return value.toFixed(3)
}

function formatAriaValue(value: number): string {
  return value.toFixed(3)
}

function normalizedDevicePixelRatio(): number {
  const requestedScale = window.devicePixelRatio
  if (!Number.isFinite(requestedScale)) return 1
  return Math.min(2, Math.max(1, requestedScale))
}

function prepareCanvas(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  scale: number,
): void {
  const rasterWidth = Math.max(1, Math.round(width * scale))
  const rasterHeight = Math.max(1, Math.round(height * scale))
  if (canvas.width !== rasterWidth) canvas.width = rasterWidth
  if (canvas.height !== rasterHeight) canvas.height = rasterHeight
  context.setTransform(scale, 0, 0, scale, 0, 0)
}

function hash(integer: number): number {
  let value = integer
  value = Math.imul((value >>> 16) ^ value, 0x21f0aaad)
  value = Math.imul((value >>> 15) ^ value, 0x735a2d97)
  return (((value >>> 15) ^ value) >>> 0) / 0x100000000
}

function paintScene(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  time: number,
  seed: number,
): void {
  const progress = time / duration
  const hue = (seed * 37 + 218) % 360
  const sky = context.createLinearGradient(0, 0, 0, height)
  sky.addColorStop(0, `hsl(${hue} 38% ${13 + progress * 8}%)`)
  sky.addColorStop(.58, `hsl(${(hue + 32) % 360} 46% ${34 + progress * 8}%)`)
  sky.addColorStop(1, `hsl(${(hue + 56) % 360} 56% ${49 + progress * 7}%)`)
  context.fillStyle = sky
  context.fillRect(0, 0, width, height)

  const starOpacity = Math.max(0, .46 - progress * .58)
  for (let starIndex = 0; starIndex < 46; starIndex++) {
    const starX = hash(seed * 211 + starIndex * 13) * width
    const starY = hash(seed * 83 + starIndex * 29) * height * .48
    const twinkle = .35 + .65 * Math.abs(Math.sin(time * 1.4 + starIndex * 2.1))
    context.fillStyle = `rgba(255,255,255,${starOpacity * twinkle})`
    context.fillRect(starX, starY, 1.3, 1.3)
  }

  const sunX = width * (.14 + progress * .72)
  const sunY = height * (.4 - Math.sin(progress * Math.PI) * .18)
  const sunRadius = height * .075
  const glow = context.createRadialGradient(sunX, sunY, 0, sunX, sunY, sunRadius * 4)
  glow.addColorStop(0, 'rgba(255,241,197,.86)')
  glow.addColorStop(1, 'rgba(255,219,145,0)')
  context.fillStyle = glow
  context.fillRect(0, 0, width, height)
  context.fillStyle = '#fff2c8'
  context.beginPath()
  context.arc(sunX, sunY, sunRadius, 0, Math.PI * 2)
  context.fill()

  for (let layer = 0; layer < 3; layer++) {
    const base = height * (.56 + layer * .13)
    const amplitude = height * (.13 - layer * .024)
    context.fillStyle = `hsl(${(hue + 112) % 360} ${25 - layer * 4}% ${13 + layer * 8}%)`
    context.beginPath()
    context.moveTo(0, height)
    for (let x = 0; x <= width + 8; x += 8) {
      const phase = (x / width) * Math.PI * (2.7 + layer * .7)
      const y = base
        - Math.sin(phase + seed * .9 + layer * 1.8) * amplitude
        - Math.sin(phase * 2.15 + seed * .4) * amplitude * .36
      context.lineTo(x, y)
    }
    context.lineTo(width, height)
    context.closePath()
    context.fill()
  }

  const waterTop = height * .84
  const water = context.createLinearGradient(0, waterTop, 0, height)
  water.addColorStop(0, `hsl(${hue} 34% 17%)`)
  water.addColorStop(1, `hsl(${(hue + 32) % 360} 40% 10%)`)
  context.fillStyle = water
  context.fillRect(0, waterTop, width, height - waterTop)
  context.fillStyle = 'rgba(255,235,187,.18)'
  context.fillRect(sunX - sunRadius * .55, waterTop, sunRadius * 1.1, height - waterTop)
}

function paintPreview(layout: EditorLayout, scale: number): void {
  prepareCanvas(
    domCache.preview,
    domCache.previewContext,
    layout.preview.preview.width,
    layout.preview.preview.height,
    scale,
  )
  domCache.previewContext.clearRect(
    0,
    0,
    layout.preview.preview.width,
    layout.preview.preview.height,
  )
  paintScene(
    domCache.previewContext,
    layout.preview.preview.width,
    layout.preview.preview.height,
    state.time,
    state.selectedClip,
  )
}

function paintFilmstrip(layout: EditorLayout, scale: number): void {
  const width = layout.timeline.track.width
  const height = layout.timeline.track.height
  const unchanged = paintCache.filmstripWidth === width
    && paintCache.filmstripHeight === height
    && paintCache.filmstripScale === scale
    && paintCache.selectedClip === state.selectedClip
  if (unchanged) return

  paintCache.filmstripWidth = width
  paintCache.filmstripHeight = height
  paintCache.filmstripScale = scale
  paintCache.selectedClip = state.selectedClip
  prepareCanvas(domCache.filmstrip, domCache.filmstripContext, width, height, scale)
  domCache.filmstripContext.clearRect(0, 0, width, height)
  const thumbnailWidth = height * 1.6
  const thumbnailCount = Math.max(1, Math.ceil(width / thumbnailWidth))
  for (let thumbnailIndex = 0; thumbnailIndex < thumbnailCount; thumbnailIndex++) {
    const left = thumbnailIndex * thumbnailWidth
    const thumbnailTime = ((thumbnailIndex + .5) / thumbnailCount) * duration
    domCache.filmstripContext.save()
    domCache.filmstripContext.beginPath()
    domCache.filmstripContext.rect(left, 0, thumbnailWidth, height)
    domCache.filmstripContext.clip()
    domCache.filmstripContext.translate(left, 0)
    paintScene(
      domCache.filmstripContext,
      thumbnailWidth,
      height,
      thumbnailTime,
      state.selectedClip,
    )
    domCache.filmstripContext.restore()
  }
}

function writeLayout(layout: EditorLayout, cursor: string): void {
  const headerRectangle = {
    left: 0,
    top: 0,
    right: layout.viewportWidth,
    bottom: layout.chrome.headerHeight,
    width: layout.viewportWidth,
    height: layout.chrome.headerHeight,
  }
  setRectangle(domCache.header, headerRectangle, 0, 0)
  setRectangle(domCache.stage, layout.preview.stage, 0, 0)
  setRectangle(
    domCache.previewShell,
    layout.preview.preview,
    layout.preview.stage.left,
    layout.preview.stage.top,
  )
  setRectangle(
    domCache.cropOverlay,
    layout.crop.rectangle,
    layout.preview.preview.left,
    layout.preview.preview.top,
  )
  setRectangle(domCache.rangeCard, layout.rangeCard, 0, 0)
  setRectangle(domCache.timelineArea, layout.timeline.area, 0, 0)
  setRectangle(
    domCache.playButton,
    layout.timeline.playButton,
    layout.timeline.area.left,
    layout.timeline.area.top,
  )
  setRectangle(
    domCache.timeReadout,
    layout.timeline.timeReadout,
    layout.timeline.area.left,
    layout.timeline.area.top,
  )
  setRectangle(
    domCache.timeline,
    layout.timeline.track,
    layout.timeline.area.left,
    layout.timeline.area.top,
  )
  setRectangle(domCache.mediaPanel, layout.menu.panel, 0, 0)
  setRectangle(
    domCache.mediaHeader,
    layout.menu.header,
    layout.menu.panel.left,
    layout.menu.panel.top,
  )
  setRectangle(
    domCache.mediaToggle,
    layout.menu.toggle,
    layout.menu.panel.left,
    layout.menu.panel.top,
  )

  const leftShadeWidth = layout.timeline.startX
  const rightShadeWidth = Math.max(0, layout.timeline.track.width - layout.timeline.endX)
  domCache.leftShade.style.transform = 'translate3d(0, 0, 0)'
  domCache.leftShade.style.width = `${leftShadeWidth}px`
  domCache.rightShade.style.transform = 'translate3d(0, 0, 0)'
  domCache.rightShade.style.width = `${rightShadeWidth}px`
  domCache.trimSelection.style.transform = `translate3d(${layout.timeline.startX}px, 0, 0)`
  domCache.trimSelection.style.width = `${Math.max(0, layout.timeline.endX - layout.timeline.startX)}px`
  domCache.playhead.style.transform = `translate3d(${layout.timeline.playheadX - 1.5}px, 0, 0)`

  const drag = state.drag
  const timelineDragging = drag != null && drag.kind === 'timeline'
  const bubbleTime = drag != null && drag.kind === 'timeline'
    ? drag.control === 'start'
      ? layout.timeline.start
      : drag.control === 'end'
        ? layout.timeline.end
        : layout.timeline.playhead
    : layout.timeline.playhead
  const bubbleX = drag != null && drag.kind === 'timeline'
    ? drag.control === 'start'
      ? layout.timeline.startX
      : drag.control === 'end'
        ? layout.timeline.endX
        : layout.timeline.playheadX
    : layout.timeline.playheadX
  domCache.scrubBubble.style.display = timelineDragging ? 'block' : 'none'
  domCache.scrubBubble.style.left = '0px'
  domCache.scrubBubble.style.transform = `translate3d(${bubbleX}px, 0, 0) translateX(-50%)`
  domCache.scrubBubble.textContent = formatTime(bubbleTime)

  domCache.playButton.className = state.playing ? 'playing' : ''
  domCache.playButton.setAttribute('aria-label', state.playing ? 'Pause' : 'Play')
  domCache.currentTime.textContent = layout.timeline.playhead.toFixed(2)
  domCache.totalTime.textContent = duration.toFixed(2)
  domCache.mediaToggleGlyph.textContent = state.menuExpanded ? '−' : '+'
  domCache.mediaToggle.setAttribute(
    'aria-label',
    state.menuExpanded ? 'Collapse media menu' : 'Expand media menu',
  )
  domCache.mediaToggle.setAttribute('aria-expanded', String(state.menuExpanded))

  const cropMaximumWidth = 1 - layout.crop.normalized.left
  const cropMaximumHeight = 1 - layout.crop.normalized.top
  domCache.cropOverlay.setAttribute(
    'aria-label',
    `Crop rectangle. Approximate x ${formatNormalizedMetric(layout.crop.normalized.left)} from 0 to ${formatNormalizedMetric(layout.crop.maximumLeft)}; approximate y ${formatNormalizedMetric(layout.crop.normalized.top)} from 0 to ${formatNormalizedMetric(layout.crop.maximumTop)}; approximate width ${formatNormalizedMetric(layout.crop.normalized.width)} and height ${formatNormalizedMetric(layout.crop.normalized.height)}. Arrow keys move. Shift plus Arrow keys resize the right or bottom edge. Minimum size ${formatNormalizedMetric(minimumCropSize)}.`,
  )

  const maximumKeyboardStart = Math.max(0, layout.timeline.end - minimumClipDuration)
  domCache.trimStartHandle.setAttribute('aria-valuemin', '0')
  domCache.trimStartHandle.setAttribute('aria-valuemax', formatAriaValue(maximumKeyboardStart))
  domCache.trimStartHandle.setAttribute('aria-valuenow', formatAriaValue(layout.timeline.start))
  domCache.trimStartHandle.setAttribute('aria-valuetext', formatTime(layout.timeline.start))
  domCache.trimEndHandle.setAttribute('aria-valuemin', formatAriaValue(layout.timeline.minimumEnd))
  domCache.trimEndHandle.setAttribute('aria-valuemax', formatAriaValue(duration))
  domCache.trimEndHandle.setAttribute('aria-valuenow', formatAriaValue(layout.timeline.end))
  domCache.trimEndHandle.setAttribute('aria-valuetext', formatTime(layout.timeline.end))
  domCache.playhead.setAttribute('aria-valuemin', formatAriaValue(layout.timeline.start))
  domCache.playhead.setAttribute('aria-valuemax', formatAriaValue(layout.timeline.end))
  domCache.playhead.setAttribute('aria-valuenow', formatAriaValue(layout.timeline.playhead))
  domCache.playhead.setAttribute('aria-valuetext', formatTime(layout.timeline.playhead))
  domCache.mediaPanel.style.zIndex = state.drag != null && state.drag.kind === 'menu'
    ? '300'
    : state.menuRecentlyReleased
      ? '200'
      : '50'

  for (let itemIndex = 0; itemIndex < domCache.mediaItems.length; itemIndex++) {
    const itemNode = domCache.mediaItems[itemIndex]
    if (itemNode == null) throw new Error('Media DOM cache lost an item')
    const itemRectangle = mediaItemRectangle(
      layout.menu.panel.left,
      layout.menu.panel.top,
      layout.menu.panel.width,
      layout.menu.itemWidth,
      layout.menu.itemHeight,
      itemIndex,
    )
    setRectangle(itemNode, itemRectangle, layout.menu.panel.left, layout.menu.panel.top)
    itemNode.style.display = state.menuExpanded ? 'block' : 'none'
    itemNode.className = itemIndex === state.selectedClip ? 'mediaItem selected' : 'mediaItem'
    itemNode.setAttribute('aria-pressed', String(itemIndex === state.selectedClip))
  }

  const previewWidth = formatMetric(layout.preview.preview.width)
  const previewHeight = formatMetric(layout.preview.preview.height)
  const cropSourceWidth = Math.round(layout.crop.normalized.width * 1280)
  const cropSourceHeight = Math.round(layout.crop.normalized.height * 720)
  domCache.metricReadout.textContent = layout.chrome.compact
    ? `${previewWidth}×${previewHeight} · src crop ${cropSourceWidth}×${cropSourceHeight}`
    : `preview ${previewWidth}×${previewHeight} · src crop ${cropSourceWidth}×${cropSourceHeight} · track ${formatMetric(layout.timeline.track.width)}`
  const annotationLineOne = `proof viewport w[${minimumViewportWidth}, ${maximumLayoutSize}] h[${minimumViewportHeight}, ${maximumLayoutSize}] · heights header ${layout.chrome.headerHeight} timeline ${layout.chrome.timelineHeight} · gaps stage ${layout.chrome.stagePadding} timeline pad/gap ${layout.chrome.timelinePadding}/${layout.chrome.timelineGap} corner ${layout.chrome.cornerMargin} snapped card/menu ≥${rangeCardMenuGap}`
  const annotationLineTwo = `≈ preview ${previewWidth}×${previewHeight} crop-screen ${formatMetric(layout.crop.rectangle.width)}×${formatMetric(layout.crop.rectangle.height)} source ${cropSourceWidth}×${cropSourceHeight} · crop x[0, ${formatNormalizedMetric(layout.crop.maximumLeft)}] y[0, ${formatNormalizedMetric(layout.crop.maximumTop)}] east-w[${formatNormalizedMetric(minimumCropSize)}, ${formatNormalizedMetric(cropMaximumWidth)}] south-h[${formatNormalizedMetric(minimumCropSize)}, ${formatNormalizedMetric(cropMaximumHeight)}]`
  const annotationLineThree = `≈ clip track ${formatMetric(layout.timeline.track.width)}×${timelineTrackHeight} start[0, ${formatNormalizedMetric(layout.timeline.maximumStart)}] end[${formatNormalizedMetric(layout.timeline.minimumEnd)}, ${duration}] min-length ${minimumClipDuration} · menu ${formatMetric(layout.menu.panel.width)}×${formatMetric(layout.menu.panel.height)} header/pad/gap ${mediaHeaderHeight}/${mediaPadding}/${mediaGap} item ${formatMetric(layout.menu.itemWidth)}×${formatMetric(layout.menu.itemHeight)} snap-x{${formatMetric(layout.menu.minimumLeft)}, ${formatMetric(layout.menu.maximumLeft)}} snap-y{${formatMetric(layout.menu.minimumTop)}, ${formatMetric(layout.menu.maximumTop)}}`
  domCache.rangeCard.textContent = `${annotationLineOne}\n${annotationLineTwo}\n${annotationLineThree}`
  document.body.style.cursor = cursor

  const scale = normalizedDevicePixelRatio()
  paintPreview(layout, scale)
  paintFilmstrip(layout, scale)
}

function render(now: number): boolean {
  // DOM reads are batched before any state transition or DOM write.
  const viewport = readViewport()
  let layout = calculateStateLayout(viewport)
  const inputs = state.inputs

  // Raw events are interpreted together with the current state and calculated hit targets.
  for (const input of inputs) {
    processInput(layout, input)
    layout = calculateStateLayout(viewport)
  }

  // Layout retargeting precedes animation. Playback and springs use the rAF timestamp.
  const menuAnimating = advanceMenuAnimation(now, layout)
  const playbackAnimating = advancePlayback(now)
  layout = calculateStateLayout(viewport)

  // Commit normalized state and expire the one-frame event queue.
  state.crop = {
    left: layout.crop.normalized.left,
    top: layout.crop.normalized.top,
    width: layout.crop.normalized.width,
    height: layout.crop.normalized.height,
  }
  state.trimStart = layout.timeline.start
  state.trimEnd = layout.timeline.end
  state.time = layout.timeline.playhead
  state.inputs = []

  const cursor = cursorForLayout(layout)
  writeLayout(layout, cursor)
  return menuAnimating || playbackAnimating
}

function verifyDesktopGeometry(): void {
  const preview = calculatePreviewLayout(1440, 900)
  const timeline = calculateTimelineLayout(1440, 900, 12, 1.2, 9.8, 4.25)
  const menu = calculateMenuLayout(1440, 900, true, 0, 0, 'bottomRight')
  console.assert(preview.stage.top === 52)
  console.assert(preview.stage.bottom === 792)
  console.assert(timeline.track.width === 1238)
  console.assert(timeline.startX === 123.8)
  console.assert(menu.maximumLeft === 1156)
  console.assert(menu.minimumTop === 68)
}

function verifyCompactGeometry(): void {
  const timeline = calculateTimelineLayout(390, 844, 12, 1.2, 9.8, 4.25)
  const menu = calculateMenuLayout(390, 844, true, 0, 0, 'bottomRight')
  console.assert(timeline.area.top === 728)
  console.assert(timeline.track.width === 228)
  console.assert(timeline.startX > 22.79)
  console.assert(timeline.startX < 22.81)
  console.assert(menu.maximumLeft === 110)
  console.assert(menu.minimumTop === 60)
}

function verifyShortViewportGeometry(): void {
  const preview = calculatePreviewLayout(844, 390)
  const timeline = calculateTimelineLayout(844, 390, 12, 1.2, 9.8, 4.25)
  const menu = calculateMenuLayout(844, 390, true, 0, 0, 'bottomRight')
  const finalMenuItem = mediaItemRectangle(
    menu.panel.left,
    menu.panel.top,
    menu.panel.width,
    menu.itemWidth,
    menu.itemHeight,
    2,
  )
  console.assert(preview.stage.bottom === 282)
  console.assert(timeline.area.top === 282)
  console.assert(timeline.area.bottom === 390)
  console.assert(menu.panel.bottom <= timeline.area.top)
  console.assert(finalMenuItem.bottom <= menu.panel.bottom)
}

function verifyMinimumViewportCollisions(): void {
  const crop = {left: 0.15, top: 0.12, width: 0.7, height: 0.76}
  const topMenu = calculateEditorLayout(
    300,
    minimumViewportHeight,
    crop,
    1.2,
    9.8,
    4.25,
    true,
    0,
    0,
    'topRight',
  )
  const bottomMenu = calculateEditorLayout(
    300,
    minimumViewportHeight,
    crop,
    1.2,
    9.8,
    4.25,
    true,
    maximumLayoutSize,
    maximumLayoutSize,
    'bottomRight',
  )
  runtimeAssert(
    topMenu.rangeCard.top >= topMenu.menu.panel.bottom,
    'Top menu must not cover the minimum-viewport range card',
  )
  runtimeAssert(
    bottomMenu.rangeCard.bottom <= bottomMenu.menu.panel.top,
    'Bottom menu must not cover the minimum-viewport range card',
  )
  runtimeAssert(
    topMenu.rangeCard.bottom <= topMenu.timeline.area.top,
    'Top-menu range card must stay above the timeline',
  )
  runtimeAssert(
    bottomMenu.rangeCard.bottom <= bottomMenu.timeline.area.top,
    'Bottom-menu range card must stay above the timeline',
  )
}

function runtimeAssert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function runtimeAssertClose(actual: number, expected: number): void {
  const difference = Math.abs(actual - expected)
  if (difference > 0.000_001) {
    throw new Error(`Expected ${actual} to be close to ${expected}`)
  }
}

function verifyRepeatedCropDrag(): void {
  const firstMove = cropAfterDrag(
    {left: 0.15, top: 0.12, width: 0.7, height: 0.76},
    'move',
    -1,
    1,
  )
  const secondMove = cropAfterDrag(firstMove, 'move', 1, -1)
  console.assert(firstMove.left >= 0)
  console.assert(firstMove.top >= 0)
  console.assert(firstMove.width >= minimumCropSize)
  console.assert(firstMove.height >= minimumCropSize)
  console.assert(secondMove.left >= 0)
  console.assert(secondMove.top >= 0)
  console.assert(secondMove.width <= 1)
  console.assert(secondMove.height <= 1)

  // Freerange proves the composed bounds above, but not exact values through the handle
  // switch. These runtime checks cover the concrete example without overstating proof.
  runtimeAssertClose(firstMove.left, 0)
  runtimeAssertClose(firstMove.top, 0.24)
  runtimeAssertClose(secondMove.left, 0.3)
  runtimeAssertClose(secondMove.top, 0)
}

function verifyRepeatedTimelineEdit(): void {
  const first = calculateTimelineLayout(1440, 900, 12, 8, 8.2, 11)
  const second = calculateTimelineLayout(1440, 900, 12, first.start, 6, first.playhead)
  console.assert(first.start === 8)
  console.assert(first.end === 9)
  console.assert(first.playhead === 9)
  console.assert(second.start === 8)
  console.assert(second.end === 9)
  console.assert(second.playhead === 9)
}

verifyDesktopGeometry()
verifyCompactGeometry()
verifyShortViewportGeometry()
verifyMinimumViewportCollisions()
verifyRepeatedCropDrag()
verifyRepeatedTimelineEdit()

domCache.playButton.addEventListener('click', handlePlayActivation)
domCache.mediaToggle.addEventListener('click', handleMenuActivation)
for (let itemIndex = 0; itemIndex < domCache.mediaItems.length; itemIndex++) {
  const mediaItem = domCache.mediaItems[itemIndex]
  if (mediaItem == null) throw new Error('Media DOM cache lost an activation target')
  mediaItem.addEventListener('click', function handleMediaActivation(event) {
    queueMediaSelection(itemIndex, event)
  })
}

window.addEventListener('resize', scheduleRender)
window.addEventListener('pointerdown', handlePointerDown)
window.addEventListener('pointermove', handlePointerMove)
window.addEventListener('pointerup', handlePointerUp)
window.addEventListener('pointercancel', handlePointerCancel)
window.addEventListener('keydown', handleKeyDown)
window.addEventListener('blur', handleWindowBlur)

// Initialization uses the same render path as every later frame, before first paint.
if (render(0)) scheduleRender()
