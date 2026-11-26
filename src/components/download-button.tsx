import LoaderCircle from "lucide-react/icons/loader-circle"
import { Button } from "@/components/ui/button"

export function DownloadButton({ busy, disabled, label }: {
  busy: boolean; disabled: boolean; label: string
}) {
  return <Button type="submit" size="lg" className="download-button" disabled={disabled} aria-busy={busy}>
    {busy && <LoaderCircle data-icon="inline-start" className="spinner" />}
    {label}
  </Button>
}
