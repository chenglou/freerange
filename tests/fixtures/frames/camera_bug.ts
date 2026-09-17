// A side-scrolling camera keeps the player inside a dead zone, the middle 40% of the viewport. The zone is a cached
// measurement of the viewport width.
type Camera = {viewportWidth: number; zoneLeft: number; zoneRight: number; cameraX: number; playerX: number}
type CameraEvent = {kind: 'move'; dx: number} | {kind: 'resize'; width: number} | {kind: 'idle'}

function initCamera(viewportWidth: number): Camera {
  console.assert(viewportWidth >= 320)
  console.assert(viewportWidth <= 3840)
  const camera = {viewportWidth, zoneLeft: viewportWidth * 0.3, zoneRight: viewportWidth * 0.7, cameraX: 0, playerX: viewportWidth * 0.5}
  return camera
}

// The camera position that moves the least to bring the player's screen x into [zoneLeft, zoneRight].
function follow(playerX: number, cameraX: number, zoneLeft: number, zoneRight: number): number {
  const screenX = playerX - cameraX
  if (screenX > zoneRight) return playerX - zoneRight
  if (screenX < zoneLeft) return playerX - zoneLeft
  return cameraX
}

function move(prev: Camera, dx: number): Camera {
  console.assert(dx >= -64)
  console.assert(dx <= 64)
  const playerX = prev.playerX + dx
  const cameraX = follow(playerX, prev.cameraX, prev.zoneLeft, prev.zoneRight)
  const next = {viewportWidth: prev.viewportWidth, zoneLeft: prev.zoneLeft, zoneRight: prev.zoneRight, cameraX, playerX}
  return next
}

function resize(prev: Camera, width: number): Camera {
  console.assert(width >= 320)
  console.assert(width <= 3840)
  const zoneLeft = width * 0.3
  const zoneRight = width * 0.7
  const cameraX = follow(prev.playerX, prev.cameraX, zoneLeft, zoneRight)
  // Bug: the resize frame itself uses the new zone, but the cache keeps the zone of the old width.
  const next = {viewportWidth: width, zoneLeft: prev.zoneLeft, zoneRight: prev.zoneRight, cameraX, playerX: prev.playerX}
  return next
}

function stepCamera(prev: Camera, event: CameraEvent): Camera {
  const next = event.kind === 'move' ? move(prev, event.dx) : event.kind === 'resize' ? resize(prev, event.width) : prev
  const screenX = next.playerX - next.cameraX
  console.assert(screenX >= 0)
  console.assert(screenX <= next.viewportWidth)
  return next
}

// The frame driver: the window opens at viewportWidth, then one event per frame.
export function cameraFrames(viewportWidth: number, events: CameraEvent[]): void {
  console.assert(viewportWidth >= 320)
  console.assert(viewportWidth <= 3840)
  let camera = initCamera(viewportWidth)
  for (const event of events) {
    camera = stepCamera(camera, event)
  }
}
