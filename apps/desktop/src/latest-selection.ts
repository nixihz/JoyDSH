export interface LatestSelection {
  begin(): number
  isCurrent(selection: number): boolean
  invalidate(): void
}

export function createLatestSelection(): LatestSelection {
  let currentSelection = 0

  return {
    begin() {
      currentSelection += 1
      return currentSelection
    },
    isCurrent(selection) {
      return selection === currentSelection
    },
    invalidate() {
      currentSelection += 1
    },
  }
}
