let claimed = false

export function claimIsolation() {
  if (claimed) return false
  claimed = true
  return true
}
