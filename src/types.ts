export type Phase = "idle" | "starting" | "downloading" | "converting" | "prepared" | "saving" | "cancelling" | "complete" | "error" | "cancelled"
export interface DownloadState {
  phase: Phase
  connected: boolean
  total: number
  error: string
  revision?: number
  folder?: string
  format?: string
  percent?: number | null
  speed?: number | null
  eta?: number | null
  info?: { title: string; duration?: number; thumbnail?: string }
  path?: string
  filename?: string
  history: { title: string; format: string; filename: string; date: string }[]
}
