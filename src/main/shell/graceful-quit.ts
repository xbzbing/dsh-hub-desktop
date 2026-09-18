/** Coordinates one application shutdown and finishes it without re-entering Electron's quit lifecycle. */
export interface QuitEventLike {
  preventDefault(): void
}

export interface GracefulQuitDeps {
  cleanup(): Promise<void>
  /** Uses Electron's immediate exit after cleanup has completed. */
  exit(code: number): void
  onStart?(): void
  onError?(error: unknown): void
}

export interface GracefulQuit {
  handleBeforeQuit(event: QuitEventLike): void
  isQuitting(): boolean
}

export function createGracefulQuit(deps: GracefulQuitDeps): GracefulQuit {
  let quitting = false

  return {
    isQuitting: () => quitting,

    handleBeforeQuit(event) {
      // Always consume the event while cleanup or final exit is in flight. A second Cmd+Q must
      // never turn an orderly shutdown into a window-only close.
      event.preventDefault()
      if (quitting) return

      quitting = true
      deps.onStart?.()
      void deps
        .cleanup()
        .catch((error: unknown) => deps.onError?.(error))
        .finally(() => deps.exit(0))
    }
  }
}
