"""Chrome native messaging host. stdout is reserved for framed JSON messages."""

import collections
import http.server
import json
import os
from pathlib import Path
import re
import secrets
import struct
import subprocess
import sys
import tempfile
import threading
from urllib.parse import quote, urlsplit

HOST_NAME = "com.musical.downloader"
write_lock = threading.Lock()
job_lock = threading.Lock()
process = None
worker = None
transfer = None
cancelled = threading.Event()
ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / "config.json"


def send(message):
    data = json.dumps(message, ensure_ascii=False).encode("utf-8")
    with write_lock:
        sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
        sys.stdout.buffer.flush()


def read_exact(stream, size):
    result = bytearray()
    while len(result) < size:
        chunk = stream.read(size - len(result))
        if not chunk:
            if not result:
                return None
            raise ValueError("Incomplete message")
        result.extend(chunk)
    return bytes(result)


def read_message(stream):
    header = read_exact(stream, 4)
    if header is None:
        return None
    size = struct.unpack("<I", header)[0]
    if size > 65536:
        raise ValueError("Message too large")
    data = read_exact(stream, size)
    if data is None:
        raise ValueError("Missing message")
    message = json.loads(data)
    if not isinstance(message, dict):
        raise ValueError("Expected an object")
    return message


def validate_request(url, file_format):
    if not isinstance(url, str) or len(url) > 8192:
        raise ValueError("Paste a valid video link.")
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Use a public http or https video link.")
    if file_format not in ("mp3", "mp4"):
        raise ValueError("Choose MP3 or MP4.")


def download_folder():
    if os.name == "nt":
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders") as key:
                value = winreg.QueryValueEx(key, "{374DE290-123F-4565-9164-39C4925E467B}")[0]
                return Path(os.path.expandvars(value))
        except OSError:
            pass
    return Path.home() / "Downloads"


def build_command(url, file_format, config, output_dir):
    validate_request(url, file_format)
    command = [sys.executable, "-m", "yt_dlp", "--ignore-config", "--no-plugin-dirs",
               "--no-playlist", "--no-simulate", "--newline", "--progress",
               "--progress-delta", "0.5", "--windows-filenames", "--no-overwrites",
               "--match-filter", "!is_live", "--ffmpeg-location", config["ffmpeg"],
               "--js-runtimes", "node:" + config["node"],
               "-P", str(output_dir),
               "-o", "%(title).140B [%(id)s].%(ext)s",
               "--progress-template", "download:MUSICAL_PROGRESS:%(progress)j",
               "--progress-template", "postprocess:MUSICAL_CONVERT:%(progress.status)s",
               "--print", "before_dl:MUSICAL_INFO:%(.{id,title,duration,thumbnail})j",
               "--print", "after_move:MUSICAL_FILE:%(filepath)j"]
    if file_format == "mp3":
        command += ["-f", "bestaudio[ext=webm]/bestaudio/best", "-x", "--audio-format", "mp3", "--audio-quality", "192K"]
    else:
        command += ["-f", "bestvideo[vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/bestvideo+bestaudio/best",
                    "--merge-output-format", "mp4", "--recode-video", "mp4",
                    "--postprocessor-args", "VideoConvertor+ffmpeg_o:-c:v libx264 -c:a aac"]
    return command + ["--", url]


def share_file(output, staging):
    token = "/" + secrets.token_urlsafe(32)

    class FileHandler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_HEAD(self):
            self.serve_file(False)

        def do_GET(self):
            self.serve_file(True)

        def serve_file(self, include_body):
            if self.path != token:
                self.send_error(404)
                return
            size = output.stat().st_size
            start, end = 0, size - 1
            requested_range = self.headers.get("Range")
            if requested_range:
                match = re.fullmatch(r"bytes=(\d+)-(\d*)", requested_range)
                if not match or int(match[1]) >= size:
                    self.send_error(416)
                    return
                start = int(match[1])
                end = min(int(match[2]) if match[2] else end, end)
                if end < start:
                    self.send_error(416)
                    return
            self.send_response(206 if requested_range else 200)
            self.send_header("Content-Type", "audio/mpeg" if output.suffix == ".mp3" else "video/mp4")
            self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + quote(output.name))
            self.send_header("Content-Length", str(end - start + 1))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Cache-Control", "no-store")
            if requested_range:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            if include_body:
                try:
                    with output.open("rb") as source:
                        source.seek(start)
                        remaining = end - start + 1
                        while remaining:
                            chunk = source.read(min(262144, remaining))
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                            remaining -= len(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FileHandler)
    server.daemon_threads = False
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return {"server": server, "staging": staging,
            "url": f"http://127.0.0.1:{server.server_port}{token}"}


def release_file():
    global transfer
    current = transfer
    transfer = None
    if current:
        current["server"].shutdown()
        current["server"].server_close()
        current["staging"].cleanup()


def stop_download():
    cancelled.set()
    with job_lock:
        current = process
        if current and current.poll() is None:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(current.pid), "/T", "/F"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               creationflags=subprocess.CREATE_NO_WINDOW)
            else:
                current.terminate()


def download(message):
    global process, worker, transfer
    errors = collections.deque(maxlen=8)
    output = None
    outcome = None
    staging = None
    try:
        config = json.loads(CONFIG.read_text(encoding="utf-8-sig"))
        staging = tempfile.TemporaryDirectory(prefix="musical-")
        command = build_command(message["url"], message["format"], config, staging.name)
        with job_lock:
            if cancelled.is_set():
                return
            # Child tools must never read Chrome's message pipe.
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                       text=True, encoding="utf-8", errors="replace",
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        for raw in process.stdout:
            line = raw.strip()
            if line.startswith("MUSICAL_INFO:"):
                send({"type": "info", "info": json.loads(line.split(":", 1)[1])})
            elif line.startswith("MUSICAL_PROGRESS:"):
                progress = json.loads(line.split(":", 1)[1])
                total = progress.get("total_bytes") or progress.get("total_bytes_estimate")
                send({"type": "progress", "percent": min(100, 100 * progress.get("downloaded_bytes", 0) / total) if total else None,
                      "speed": progress.get("speed"), "eta": progress.get("eta")})
            elif line.startswith("MUSICAL_CONVERT:"):
                send({"type": "converting"})
            elif line.startswith("MUSICAL_FILE:"):
                output = Path(json.loads(line.split(":", 1)[1]))
            elif "ERROR:" in line:
                errors.append(line[:1000])
        code = process.wait()
        if cancelled.is_set():
            return
        if code != 0 or output is None or not output.is_file() or output.stat().st_size == 0:
            raise RuntimeError("\n".join(errors) or "Download failed. Try another link or update the helper.")
        transfer = share_file(output, staging)
        staging = None
        outcome = {"type": "prepared", "url": transfer["url"], "filename": output.name, "format": message["format"]}
    except Exception as error:
        if not cancelled.is_set():
            outcome = {"type": "error", "error": str(error)[:2500]}
    finally:
        with job_lock:
            process = None
            if cancelled.is_set():
                outcome = {"type": "cancelled"}
            worker = None
        if cancelled.is_set():
            release_file()
        if outcome:
            send(outcome)
        if staging:
            staging.cleanup()


def main():
    global worker
    if os.name == "nt":
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    try:
        while (message := read_message(sys.stdin.buffer)) is not None:
            action = message.get("action")
            if action == "ping":
                send({"type": "ready", "browserDownloads": True})
            elif action == "download":
                if (worker and worker.is_alive()) or transfer:
                    send({"type": "notice", "error": "A download is already running."})
                    continue
                validate_request(message.get("url"), message.get("format"))
                cancelled.clear()
                worker = threading.Thread(target=download, args=(message,), daemon=True)
                worker.start()
            elif action == "cancel":
                stop_download()
            elif action == "release":
                release_file()
            elif action == "folder":
                folder = download_folder()
                folder.mkdir(parents=True, exist_ok=True)
                os.startfile(folder)
            else:
                send({"type": "error", "error": "Unknown action."})
    except (ValueError, OSError) as error:
        send({"type": "error", "error": str(error)})
    finally:
        stop_download()
        if worker:
            worker.join(timeout=15)
        release_file()


if __name__ == "__main__":
    main()
