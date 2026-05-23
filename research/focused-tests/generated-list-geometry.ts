// Generated-list geometry for tables of contents, outline rows, and lists of figures.
// The verifier checks this source directly; no browser wrapper is needed.

export type GeneratedListLevel = 'section' | 'subsection' | 'subsubsection' | 'caption'
export type GeneratedListDocumentClass = 'article' | 'report' | 'book'

export type GeneratedListEntryInput = {
  level: GeneratedListLevel
  documentClass: GeneratedListDocumentClass
  lineWidths: number[]
  numberWidth: number
  // -1 means this entry has no trailing page-number slot, so it has no leader either.
  pageNumberWidth: number
}

export type GeneratedListLevelMetrics = {
  numberIndent: number
  textIndent: number
  numberBoxWidth: number
  dotted: boolean
  spacingBefore: number
}

export type GeneratedListLineGeometry = {
  lineIndex: number
  top: number
  bottom: number
  numberX: number
  numberWidth: number
  textX: number
  textWidth: number
  leaderFrom: number
  leaderTo: number
  pageNumberX: number
  pageNumberWidth: number
  isTerminal: number
}

export type GeneratedListEntryGeometry = {
  top: number
  bottom: number
  textMaxWidth: number
  spacingBefore: number
  metrics: GeneratedListLevelMetrics
  lines: GeneratedListLineGeometry[]
}

export type GeneratedListLayout = {
  entries: GeneratedListEntryGeometry[]
  contentHeight: number
}

export const CONTENT_LEFT = 24
export const CONTENT_WIDTH = 420
export const PAGE_NUMBER_BOX_WIDTH = 28
export const TOC_RIGHT_MARGIN = 12
export const ENTRY_LINE_HEIGHT = 18
export const BODY_EM_PX = 10

export function generatedListLevelMetrics(
  level: GeneratedListLevel,
  documentClass: GeneratedListDocumentClass,
): GeneratedListLevelMetrics {
  switch (level) {
    case 'section':
      if (documentClass === 'article') {
        return {
          numberIndent: 0,
          textIndent: 1.5 * BODY_EM_PX,
          numberBoxWidth: 1.5 * BODY_EM_PX,
          dotted: true,
          spacingBefore: 1 * BODY_EM_PX,
        }
      }
      return {
        numberIndent: 1.5 * BODY_EM_PX,
        textIndent: 3.8 * BODY_EM_PX,
        numberBoxWidth: 2.3 * BODY_EM_PX,
        dotted: true,
        spacingBefore: 1 * BODY_EM_PX,
      }
    case 'subsection':
      if (documentClass === 'article') {
        return {
          numberIndent: 1.5 * BODY_EM_PX,
          textIndent: 3.8 * BODY_EM_PX,
          numberBoxWidth: 2.3 * BODY_EM_PX,
          dotted: true,
          spacingBefore: 0,
        }
      }
      return {
        numberIndent: 3.8 * BODY_EM_PX,
        textIndent: 7.0 * BODY_EM_PX,
        numberBoxWidth: 3.2 * BODY_EM_PX,
        dotted: true,
        spacingBefore: 0,
      }
    case 'subsubsection':
      if (documentClass === 'article') {
        return {
          numberIndent: 3.8 * BODY_EM_PX,
          textIndent: 7.0 * BODY_EM_PX,
          numberBoxWidth: 3.2 * BODY_EM_PX,
          dotted: true,
          spacingBefore: 0,
        }
      }
      return {
        numberIndent: 7.0 * BODY_EM_PX,
        textIndent: 11.1 * BODY_EM_PX,
        numberBoxWidth: 4.1 * BODY_EM_PX,
        dotted: true,
        spacingBefore: 0,
      }
    case 'caption':
      return {
        numberIndent: 0,
        textIndent: 1.5 * BODY_EM_PX,
        numberBoxWidth: 2.3 * BODY_EM_PX,
        dotted: true,
        spacingBefore: 0,
      }
  }
}

export function layoutGeneratedList(entries: GeneratedListEntryInput[]): GeneratedListLayout {
  const geometries: GeneratedListEntryGeometry[] = []
  const pageBoxLeft = CONTENT_LEFT + CONTENT_WIDTH - PAGE_NUMBER_BOX_WIDTH
  const pageRight = CONTENT_LEFT + CONTENT_WIDTH
  let cursorY = 0

  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    const entry = entries[entryIndex]!
    const metrics = generatedListLevelMetrics(entry.level, entry.documentClass)
    const textX = CONTENT_LEFT + metrics.textIndent
    const hasNumber = entry.numberWidth >= 0
    const hasPageNumber = entry.pageNumberWidth >= 0
    const numberX = hasNumber ? CONTENT_LEFT + metrics.numberIndent : -1
    const textMaxWidth = Math.max(
      40,
      CONTENT_WIDTH
        - metrics.textIndent
        - PAGE_NUMBER_BOX_WIDTH
        - (metrics.dotted ? TOC_RIGHT_MARGIN : 0),
    )
    const top = cursorY + metrics.spacingBefore
    const lines: GeneratedListLineGeometry[] = []

    for (let lineIndex = 0; lineIndex < entry.lineWidths.length; lineIndex++) {
      const lineWidth = entry.lineWidths[lineIndex]!
      const isTerminal = lineIndex === entry.lineWidths.length - 1
      const showsLeader = metrics.dotted && isTerminal && hasPageNumber
      const showsPageNumber = isTerminal && hasPageNumber
      const lineTop = top + lineIndex * ENTRY_LINE_HEIGHT
      lines.push({
        lineIndex,
        top: lineTop,
        bottom: lineTop + ENTRY_LINE_HEIGHT,
        numberX: lineIndex === 0 ? numberX : -1,
        numberWidth: lineIndex === 0 ? (hasNumber ? entry.numberWidth : -1) : -1,
        textX,
        textWidth: lineWidth,
        leaderFrom: showsLeader ? textX + lineWidth : -1,
        leaderTo: showsLeader ? pageBoxLeft : -1,
        pageNumberX: showsPageNumber ? pageRight - entry.pageNumberWidth : -1,
        pageNumberWidth: showsPageNumber ? entry.pageNumberWidth : -1,
        isTerminal: isTerminal ? 1 : 0,
      })
    }

    const bottom = top + lines.length * ENTRY_LINE_HEIGHT
    geometries.push({
      top,
      bottom,
      textMaxWidth,
      spacingBefore: metrics.spacingBefore,
      metrics,
      lines,
    })
    cursorY = bottom
  }

  return {
    entries: geometries,
    contentHeight: cursorY,
  }
}
