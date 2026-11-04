"""CLI configuration checks without downloading a model or requiring a GPU.

    python3 -I -m unittest discover -s tools/align -p 'test_*.py'
"""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch


class DeviceTests(unittest.TestCase):
    def run_cli(self, options, cuda_devices=0):
        spec = importlib.util.spec_from_file_location("transcribe_under_test", Path(__file__).with_name("transcribe.py"))
        script = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(script)
        word = SimpleNamespace(word=" Alice", start=0.1, end=0.4, probability=0.9)
        model = MagicMock()
        model.transcribe.side_effect = lambda *a, **kw: (iter([SimpleNamespace(words=[word])]), None)
        factory = MagicMock(return_value=model)
        fake_whisper = SimpleNamespace(WhisperModel=factory, __version__="test")
        devices = MagicMock(return_value=cuda_devices)
        fake_ct2 = SimpleNamespace(get_cuda_device_count=devices)
        with tempfile.TemporaryDirectory() as tmp:
            track, out = Path(tmp) / "track.mp3", Path(tmp) / "transcript.json"
            track.write_bytes(b"audio fixture")
            with patch.dict(sys.modules, {"faster_whisper": fake_whisper, "ctranslate2": fake_ct2}), \
                 patch.object(sys, "argv", ["transcribe.py", "--out", str(out), *options, str(track)]), \
                 patch.object(script, "decoded", return_value=iter([])), \
                 patch.object(script, "windows", return_value=iter([(0, [], 16000)])), \
                 contextlib.redirect_stderr(io.StringIO()):
                script.main()
            doc = json.loads(out.read_text())
            self.assertEqual(doc["format"], "bookclub-transcript/1")
            self.assertEqual(doc["tracks"][0]["words"], [[100, 400, "Alice", 0.9]])
            self.assertEqual(doc["tracks"][0]["durationMs"], 1000)
            self.assertEqual(len(doc["tracks"][0]["sha256"]), 64)
            self.assertFalse(Path(str(out) + ".tmp").exists())
        return factory.call_args.kwargs, devices

    def test_cpu_defaults_are_unchanged(self):
        kwargs, devices = self.run_cli([])
        self.assertEqual(kwargs["device"], "cpu")
        self.assertEqual(kwargs["compute_type"], "int8")
        devices.assert_not_called()

    def test_cuda_defaults_to_float16(self):
        kwargs, devices = self.run_cli(["--device", "cuda"])
        self.assertEqual(kwargs["device"], "cuda")
        self.assertEqual(kwargs["compute_type"], "float16")
        devices.assert_not_called()

    def test_auto_without_gpu_uses_cpu_int8(self):
        kwargs, devices = self.run_cli(["--device", "auto"], cuda_devices=0)
        self.assertEqual((kwargs["device"], kwargs["compute_type"]), ("cpu", "int8"))
        devices.assert_called_once_with()

    def test_auto_with_gpu_uses_cuda_float16(self):
        kwargs, devices = self.run_cli(["--device", "auto"], cuda_devices=1)
        self.assertEqual((kwargs["device"], kwargs["compute_type"]), ("cuda", "float16"))
        devices.assert_called_once_with()

    def test_explicit_compute_type_threads_offline_are_preserved(self):
        kwargs, _ = self.run_cli(["--device", "cuda", "--compute-type", "int8_float16", "--threads", "2", "--offline"])
        self.assertEqual(kwargs["compute_type"], "int8_float16")
        self.assertEqual(kwargs["cpu_threads"], 2)
        self.assertTrue(kwargs["local_files_only"])

    def test_invalid_device_is_rejected(self):
        with self.assertRaises(SystemExit) as caught:
            self.run_cli(["--device", "magic"])
        self.assertEqual(caught.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
