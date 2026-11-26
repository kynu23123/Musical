import React, { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import Film from "lucide-react/icons/film"
import RefreshCw from "lucide-react/icons/refresh-cw"
import X from "lucide-react/icons/x"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { AspectRatio } from "@/components/ui/aspect-ratio"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import { Progress } from "@/components/ui/progress"
import { DownloadButton } from "@/components/download-button"
import type { DownloadState } from "@/types"
import "@fontsource/manrope/latin-400.css"
import "@fontsource/manrope/latin-500.css"
import "@fontsource/manrope/latin-600.css"
import "@fontsource/manrope/latin-700.css"
import "./styles.css"

const initial: DownloadState = { phase: "idle", connected: false, total: 0, history: [], error: "" }
const hasExtension = typeof chrome !== "undefined" && Boolean(chrome.runtime?.id)

function duration(seconds?: number) {
  if (!seconds) return ""
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`
}

function App() {
  const [state, setState] = useState(initial)
  const [url, setUrl] = useState("")
  const [format, setFormat] = useState("mp4")
  const [error, setError] = useState("")
  const [invalid, setInvalid] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)
  const busy = submitted || ["starting", "downloading", "converting", "saving", "cancelling"].includes(state.phase)
  const awaitingConfirmation = state.phase === "prepared"
  const complete = state.phase === "complete"
  const preview = !hasExtension

  function applyState(next: DownloadState) {
    setState(previous => (next.revision ?? 0) >= (previous.revision ?? 0) ? next : previous)
  }

  async function command(action: string, values = {}) {
    if (!hasExtension) {
      setError("Load the extension in Chrome to download.")
      return
    }
    try {
      const result = await chrome.runtime.sendMessage({ action, ...values })
      if (result.error) throw new Error(result.error)
      applyState(result.state)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect. Try again.")
    }
  }

  useEffect(() => {
    if (!hasExtension) return
    let draftUpdated = false
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== "local") return
      if (changes.state?.newValue) applyState(changes.state.newValue as DownloadState)
      if (changes.draft?.newValue) {
        draftUpdated = true
        const draft = changes.draft.newValue as { url: string; format: string }
        setUrl(draft.url || "")
        setFormat(draft.format || "mp4")
        setInvalid(false)
        setError("")
      }
    }
    chrome.storage.onChanged.addListener(changed)
    chrome.storage.local.get<{ draft?: { url: string; format: string } }>("draft").then(({ draft }) => {
      if (draft && !draftUpdated) { setUrl(draft.url || ""); setFormat(draft.format || "mp4") }
    })
    command("state")
    return () => chrome.storage.onChanged.removeListener(changed)
  }, [])

  useEffect(() => { setImageFailed(false) }, [state.info?.thumbnail])

  function updateDraft(nextUrl: string, nextFormat: string) {
    setUrl(nextUrl)
    setFormat(nextFormat)
    setInvalid(false)
    setError("")
    if (hasExtension) chrome.storage.local.set({ draft: { url: nextUrl, format: nextFormat } })
  }

  async function start(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    if (awaitingConfirmation) {
      setError("")
      setSubmitted(true)
      await command("confirm")
      setSubmitted(false)
      return
    }
    try {
      const parsed = new URL(url.trim())
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error()
    } catch {
      setInvalid(true)
      setError("Paste a valid video link.")
      document.getElementById("video-url")?.focus()
      return
    }
    setError("")
    setSubmitted(true)
    await command("start", { url: url.trim(), format })
    setSubmitted(false)
  }

  const phaseLabel = state.phase === "saving" ? "Saving in Chrome…"
    : awaitingConfirmation ? "Ready to save"
    : state.phase === "converting" ? "Converting…"
    : state.phase === "cancelling" ? "Cancelling…"
    : state.phase === "starting" || submitted ? "Reading the link…"
    : busy ? "Downloading…" : complete ? "Saved" : "Ready when you are"
  const thumbnail = state.info?.thumbnail?.startsWith("https://") ? state.info.thumbnail : undefined
  const visibleError = error || state.error

  return <div className="app-shell">
    <main>
      <section className="intro"><h1>Download Stuff!</h1></section>
      <Card className="download-card">
        <CardHeader><CardTitle>New download</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={start} noValidate>
            <FieldGroup>
              <Field data-invalid={invalid}>
                <FieldLabel htmlFor="video-url">Video link</FieldLabel>
                <div className="url-field"><Input id="video-url" type="url" autoComplete="off" placeholder="https://www.youtube.com/watch?v=…"
                  value={url} onChange={event => updateDraft(event.target.value, format)} disabled={busy || awaitingConfirmation}
                  aria-invalid={invalid} aria-describedby={invalid ? "download-error" : undefined} /></div>
              </Field>
              <Field>
                <FieldLabel id="format-label">Save as</FieldLabel>
                <ToggleGroup aria-labelledby="format-label" value={[format]} disabled={busy || awaitingConfirmation}
                  onValueChange={values => { if (values.length) updateDraft(url, String(values[0])) }} className="format-options" spacing={2}>
                  <ToggleGroupItem value="mp4" className="format-option"><span>MP4<small>Video</small></span></ToggleGroupItem>
                  <ToggleGroupItem value="mp3" className="format-option"><span>MP3<small>Audio</small></span></ToggleGroupItem>
                </ToggleGroup>
              </Field>
            </FieldGroup>
            <div className="submit-area">
              <DownloadButton busy={busy} disabled={busy || (!preview && !state.connected)} label={busy ? phaseLabel : awaitingConfirmation ? "Confirm download?" : `Download ${format.toUpperCase()}`} />
              {(busy || awaitingConfirmation) && <Button type="button" variant="outline" size="icon-lg" aria-label="Cancel download" disabled={state.phase === "cancelling"} onClick={() => command("cancel")}><X /></Button>}
            </div>
          </form>
        </CardContent>
      </Card>

      {visibleError && <Alert id="download-error" className="error-alert"><AlertTitle>{invalid ? "Error" : "Something needs a look"}</AlertTitle><AlertDescription>{visibleError}</AlertDescription></Alert>}

      {(busy || awaitingConfirmation || state.info || complete || state.phase === "cancelled") && <Card className="current-card">
        <CardContent>
          <AspectRatio ratio={16 / 9} className="video-preview">
            {thumbnail && !imageFailed ? <img src={thumbnail} alt="Video thumbnail" width="480" height="270" onError={() => setImageFailed(true)} /> : <Film aria-hidden="true" />}
            {state.info?.duration && <span className="duration">{duration(state.info.duration)}</span>}
          </AspectRatio>
          <h2>{state.info?.title || "Your download"}</h2>
          <div className="download-status" role="status"><span>{state.phase === "cancelled" ? "Cancelled" : phaseLabel}</span><span>{state.phase === "downloading" && state.percent != null ? `${Math.floor(state.percent)}%` : null}</span></div>
          {busy && <Progress value={state.phase === "downloading" ? state.percent ?? null : null} aria-label="Download progress" />}
          {state.phase === "downloading" && <p className="transfer-details">{state.speed ? `${(state.speed / 1048576).toFixed(1)} MB/s` : "Connecting…"}{state.eta != null ? ` · ${duration(state.eta)} left` : ""}</p>}
          {complete && <p className="saved-filename">{state.filename}</p>}
        </CardContent>
      </Card>}

      <section className="history-section" aria-labelledby="recent-title">
        <div className="section-heading"><h2 id="recent-title">Recent downloads</h2></div>
        {state.history.length === 0 ? <p className="empty-history">Downloads appear here</p> : <ul>
          {state.history.slice(0, 5).map((item, index) => <li key={`${item.date}-${index}`}>
            <span className="file-format">{item.format.toUpperCase()}</span>
            <div><p title={item.title}>{item.title}</p><span>{new Date(item.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span></div>
          </li>)}
        </ul>}
      </section>
    </main>
      {!state.connected && !preview && <Button variant="ghost" size="sm" onClick={() => { setError(""); command("state") }}><RefreshCw data-icon="inline-start" />Reconnect</Button>}
    {!state.connected && !preview && <p className="setup-note">First time? Run Setup.cmd from the app folder.</p>}
  </div>
}

createRoot(document.getElementById("root")!).render(<App />)
