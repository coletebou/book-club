"""Dockerfile /opt/align COPY must include every sibling module the runtime scripts import.

Also checks that a missing progress.py still lets the entrypoints start (soft ImportError),
so a partial GPU-box copy does not crash before the real error.
"""
from __future__ import annotations

import ast
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DOCKERFILE = ROOT / "Dockerfile"
RUNTIME_ENTRYPOINTS = ("transcribe.py", "transcribe_remote.py")


def dockerfile_align_copies() -> set[str]:
    text = DOCKERFILE.read_text(encoding="utf-8")
    names: set[str] = set()
    for m in re.finditer(
        r"^COPY\s+((?:tools/align/\S+\s+)+)/opt/align/\s*$",
        text,
        flags=re.MULTILINE,
    ):
        for token in m.group(1).split():
            if token.startswith("tools/align/"):
                names.add(Path(token).name)
    return names


def local_sibling_imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module and "." not in node.module and node.level == 0:
            found.add(node.module)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if "." not in alias.name:
                    found.add(alias.name)
    return {m for m in found if (HERE / f"{m}.py").is_file()}


class ImagePack(unittest.TestCase):
    def test_dockerfile_copies_every_sibling_import(self):
        copied = dockerfile_align_copies()
        self.assertTrue(copied, "Dockerfile must COPY tools/align/* into /opt/align/")
        self.assertIn("progress.py", copied, "progress.py must ship in the runtime image")
        for name in RUNTIME_ENTRYPOINTS:
            self.assertIn(name, copied, f"{name} must be in the runtime COPY")
            local = local_sibling_imports(HERE / name)
            missing = local - {Path(n).stem for n in copied}
            self.assertFalse(
                missing,
                f"{name} imports {sorted(local)} but Dockerfile /opt/align COPY is missing "
                f"{sorted(missing)}; copied={sorted(copied)}",
            )

    def test_entrypoints_start_without_progress_module(self):
        """Partial GPU deploy: new transcribe*.py, old tree without progress.py."""
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp)
            for name in RUNTIME_ENTRYPOINTS:
                shutil.copy2(HERE / name, dest / name)
            env = {"PATH": os.environ.get("PATH", "/usr/bin")}
            for name in RUNTIME_ENTRYPOINTS:
                p = subprocess.run(
                    [sys.executable, "-I", str(dest / name)],
                    cwd=str(dest),
                    env=env,
                    capture_output=True,
                    text=True,
                )
                self.assertNotIn("ModuleNotFoundError", p.stderr, f"{name}: {p.stderr}")
                self.assertNotIn("No module named 'progress'", p.stderr, f"{name}: {p.stderr}")


if __name__ == "__main__":
    unittest.main()
