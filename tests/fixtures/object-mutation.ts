type Spring = {
  destination: number
}

function withDestination(destination: number): Spring {
  return {destination: Math.max(1, destination)}
}

export function destinationAfterUpdate(containerWidth: number): number {
  let spring: Spring = {destination: 0}
  spring = withDestination(containerWidth)
  return spring.destination
}

export function unrelatedDestinationStaysUnchanged(containerWidth: number): number {
  const updatedSpring = withDestination(containerWidth)
  const untouchedSpring = {destination: 0}
  return Math.min(untouchedSpring.destination, updatedSpring.destination)
}
