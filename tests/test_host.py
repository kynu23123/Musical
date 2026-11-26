import importlib.util
import io
import json
from pathlib import Path
import struct
import unittest
import tempfile
import urllib.request
import urllib.error
from unittest import mock

spec = importlib.util.spec_from_file_location("host", Path(__file__).parents[1] / "host/host.py")
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class ShortReads(io.BytesIO):
    def read(self, size=-1):
        return super().read(min(size, 2))


class HostTests(unittest.TestCase):
    @unittest.skipUnless(host.os.name == "nt", "Windows Downloads registry")
    def test_download_folder_uses_the_windows_downloads_folder_directly(self):
        with mock.patch("winreg.OpenKey"), mock.patch("winreg.QueryValueEx", return_value=("C:/Users/Test/Downloads", 1)):
            self.assertEqual(host.download_folder(), Path("C:/Users/Test/Downloads"))

    def test_protocol_handles_partial_reads(self):
        message = {"action": "download", "url": "https://example.com/video"}
        data = json.dumps(message).encode()
        self.assertEqual(host.read_message(ShortReads(struct.pack("<I", len(data)) + data)), message)
        self.assertIsNone(host.read_message(io.BytesIO()))

    def test_protocol_rejects_invalid_frames(self):
        for frame in [b"\x01", struct.pack("<I", 9999999), struct.pack("<I", 2) + b"{", struct.pack("<I", 2) + b"[]"]:
            with self.subTest(frame=frame), self.assertRaises(ValueError):
                host.read_message(io.BytesIO(frame))

    def test_request_validation(self):
        for url, fmt in [(None, "mp3"), ("file:///secret", "mp4"), ("https://user:pass@example.com", "mp3"),
                         ("--exec=calc", "mp4"), ("https://example.com", "exe")]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                host.validate_request(url, fmt)

    def test_command_separates_user_input_and_disables_playlists(self):
        url = "https://www.youtube.com/watch?v=abc&list=xyz"
        for fmt in ["mp3", "mp4"]:
            command = host.build_command(url, fmt, {"ffmpeg": "C:/a folder/ffmpeg.exe", "node": "C:/node.exe"}, "C:/staging")
            self.assertEqual(command[-2:], ["--", url])
            self.assertIn("--no-playlist", command)
            self.assertIn("--ignore-config", command)
            self.assertIn("--no-plugin-dirs", command)
            self.assertIn("--no-overwrites", command)
            self.assertIn("C:/a folder/ffmpeg.exe", command)
            self.assertEqual(command[command.index("-P") + 1], "C:/staging")
        self.assertIn("--audio-format", host.build_command(url, "mp3", {"ffmpeg": "ffmpeg", "node": "node"}, "staging"))
        self.assertIn("--recode-video", host.build_command(url, "mp4", {"ffmpeg": "ffmpeg", "node": "node"}, "staging"))

    def test_browser_transfer_requires_the_token_and_supports_ranges(self):
        staging = tempfile.TemporaryDirectory()
        file = Path(staging.name) / "A song.mp3"
        file.write_bytes(b"0123456789")
        host.transfer = host.share_file(file, staging)
        url = host.transfer["url"]
        try:
            with urllib.request.urlopen(url) as response:
                self.assertEqual(response.read(), b"0123456789")
                self.assertEqual(response.headers["Content-Type"], "audio/mpeg")
            request = urllib.request.Request(url, headers={"Range": "bytes=4-7"})
            with urllib.request.urlopen(request) as response:
                self.assertEqual(response.status, 206)
                self.assertEqual(response.read(), b"4567")
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(url + "/../other-file")
            self.assertEqual(error.exception.code, 404)
            error.exception.close()
        finally:
            host.release_file()
        self.assertFalse(file.exists())


if __name__ == "__main__":
    unittest.main()
