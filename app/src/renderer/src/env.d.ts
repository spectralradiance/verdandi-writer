import type { VerdandiApi } from '../../shared/ipc'

declare global {
  interface Window {
    verdandi: VerdandiApi
  }
}

export {}
