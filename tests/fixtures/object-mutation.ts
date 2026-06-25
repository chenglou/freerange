type Spring = {
  destination: number
}

function setDestination(spring: Spring, destination: number): void {
  spring.destination = destination
}

export function destinationAfterUpdate(containerWidth: number): number {
  const spring = {destination: 0}
  const springAlias = spring
  setDestination(springAlias, Math.max(1, containerWidth))
  return spring.destination
}

export function unrelatedDestinationStaysUnchanged(containerWidth: number): number {
  const updatedSpring = {destination: 0}
  const untouchedSpring = {destination: 0}
  setDestination(updatedSpring, Math.max(1, containerWidth))
  return untouchedSpring.destination
}
