// Page-break bundles: carried page budget, keep-with-next pairs, and promoted
// heading-plus-top-float bundles in one sequence pass.

export type FlowBlockKind = 'heading' | 'topFloat' | 'body'

export type FlowBlock = {
  sourceIndex: number
  kind: FlowBlockKind
  totalHeight: number
  keepWithNext: 0 | 1
}

export type PromotedBundle = {
  heading: FlowBlock
  floats: FlowBlock[]
  nextIndex: number
  totalHeight: number
}

export type PromotedBundleSummary = {
  floatCount: number
  nextIndex: number
  totalHeight: number
  fitsOnFreshPage: 0 | 1
}

export type BlockPlacement = {
  sourceIndex: number
  kind: FlowBlockKind
  pageIndex: number
  top: number
  bottom: number
  promoted: 0 | 1
}

export type PageAssignment = {
  pageIndex: number
  blocks: FlowBlock[]
  usedHeight: number
  remainingHeight: number
}

export type PromotionRecord = {
  headingSourceIndex: number
  firstFloatSourceIndex: number
  pageIndex: number
  top: number
  bundleHeight: number
  floatCount: number
}

export type PageBreakLayout = {
  placements: BlockPlacement[]
  pages: PageAssignment[]
  promotions: PromotionRecord[]
}

function appendBlockToPage(page: PageAssignment, block: FlowBlock): PageAssignment {
  const nextBlocks: FlowBlock[] = []
  for (let blockIndex = 0; blockIndex < page.blocks.length; blockIndex++) {
    nextBlocks.push(page.blocks[blockIndex]!)
  }
  nextBlocks.push(block)

  return {
    pageIndex: page.pageIndex,
    blocks: nextBlocks,
    usedHeight: page.usedHeight + block.totalHeight,
    remainingHeight: page.remainingHeight - block.totalHeight,
  }
}

function isHeading(kind: FlowBlockKind): boolean {
  return kind === 'heading'
}

function isTopFloat(kind: FlowBlockKind): boolean {
  return kind === 'topFloat'
}

export function summarizePromotedBundle(
  headingHeight: number,
  floatHeights: number[],
  pageHeight: number,
): PromotedBundleSummary {
  let totalHeight = headingHeight
  for (let floatIndex = 0; floatIndex < floatHeights.length; floatIndex++) {
    totalHeight += floatHeights[floatIndex]!
  }
  return {
    floatCount: floatHeights.length,
    nextIndex: floatHeights.length + 1,
    totalHeight,
    fitsOnFreshPage: totalHeight <= pageHeight ? 1 : 0,
  }
}

export function collectFollowingTopFloats(
  blocks: FlowBlock[],
  startIndex: number,
  pageHeight: number,
): PromotedBundle | null {
  const heading = blocks[startIndex]
  if (heading == null || isHeading(heading.kind) === false) return null

  const floats: FlowBlock[] = []
  let cursor = startIndex + 1
  while (cursor < blocks.length && isTopFloat(blocks[cursor]!.kind)) {
    floats.push(blocks[cursor]!)
    cursor += 1
  }
  if (floats.length === 0) return null

  let totalHeight = heading.totalHeight
  for (let floatIndex = 0; floatIndex < floats.length; floatIndex++) {
    totalHeight += floats[floatIndex]!.totalHeight
  }
  if (totalHeight > pageHeight) return null

  return {
    heading,
    floats,
    nextIndex: cursor,
    totalHeight,
  }
}

export function paginateBlockFlow(
  blocks: FlowBlock[],
  pageHeight: number,
): PageBreakLayout {
  const placements: BlockPlacement[] = []
  const pages: PageAssignment[] = []
  const promotions: PromotionRecord[] = []
  let current: PageAssignment = {
    pageIndex: 0,
    blocks: [],
    usedHeight: 0,
    remainingHeight: pageHeight,
  }

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex]!
    const bundle = collectFollowingTopFloats(blocks, blockIndex, pageHeight)
    const nextBlock = blockIndex + 1 < blocks.length ? blocks[blockIndex + 1]! : null
    const pairHeight = block.keepWithNext === 1 && nextBlock != null ? block.totalHeight + nextBlock.totalHeight : block.totalHeight
    const shouldPromoteBundle = bundle != null && current.blocks.length > 0 && bundle.totalHeight > current.remainingHeight
    const shouldAdvanceForPair =
      shouldPromoteBundle === false &&
      current.blocks.length > 0 &&
      block.keepWithNext === 1 &&
      nextBlock != null &&
      pairHeight <= pageHeight &&
      pairHeight > current.remainingHeight
    const shouldAdvanceForBlock =
      shouldPromoteBundle === false &&
      shouldAdvanceForPair === false &&
      current.blocks.length > 0 &&
      block.totalHeight > current.remainingHeight

    if (shouldPromoteBundle || shouldAdvanceForPair || shouldAdvanceForBlock) {
      pages.push(current)
      current = {
        pageIndex: pages.length,
        blocks: [],
        usedHeight: 0,
        remainingHeight: pageHeight,
      }
    }

    if (shouldPromoteBundle) {
      const promotedBundle = bundle
      promotions.push({
        headingSourceIndex: promotedBundle.heading.sourceIndex,
        firstFloatSourceIndex: promotedBundle.floats[0]!.sourceIndex,
        pageIndex: current.pageIndex,
        top: current.usedHeight,
        bundleHeight: promotedBundle.totalHeight,
        floatCount: promotedBundle.floats.length,
      })
      for (let floatIndex = 0; floatIndex < promotedBundle.floats.length; floatIndex++) {
        const floatBlock = promotedBundle.floats[floatIndex]!
        placements.push({
          sourceIndex: floatBlock.sourceIndex,
          kind: floatBlock.kind,
          pageIndex: current.pageIndex,
          top: current.usedHeight,
          bottom: current.usedHeight + floatBlock.totalHeight,
          promoted: 1,
        })
        current = appendBlockToPage(current, floatBlock)
      }
      placements.push({
        sourceIndex: promotedBundle.heading.sourceIndex,
        kind: promotedBundle.heading.kind,
        pageIndex: current.pageIndex,
        top: current.usedHeight,
        bottom: current.usedHeight + promotedBundle.heading.totalHeight,
        promoted: 1,
      })
      current = appendBlockToPage(current, promotedBundle.heading)
      blockIndex = promotedBundle.nextIndex - 1
      continue
    }

    placements.push({
      sourceIndex: block.sourceIndex,
      kind: block.kind,
      pageIndex: current.pageIndex,
      top: current.usedHeight,
      bottom: current.usedHeight + block.totalHeight,
      promoted: 0,
    })
    current = appendBlockToPage(current, block)
  }

  if (current.blocks.length > 0) pages.push(current)
  return {placements, pages, promotions}
}
