#!/usr/bin/env python3
"""Build the Mac double-click application for a checked local installation."""

import argparse
import json
import os
import plistlib
import subprocess
import sys
import tempfile
from pathlib import Path


SCRIPT = Path(__file__).with_name("launcher.applescript")
DEFAULT_DATA = Path.home() / "Library" / "Application Support" / "Lovefield Tree Study"
BUNDLE_IDENTIFIER = "love.sourceof.tree-targeting"
BUNDLE_NAME = "Lovefield Tree Study"


def _apple_string(path):
    return str(path).replace("\\", "\\\\").replace('"', '\\"')


def build_launcher(runtime, source, data_directory, output, *, chrome_window_name=None, compiler=subprocess.run):
    """Compile and atomically place one app without changing an existing copy."""
    if not isinstance(chrome_window_name, str) or not chrome_window_name.strip():
        raise ValueError('Choose the verified existing private Chrome window name')
    runtime = Path(os.path.abspath(Path(runtime).expanduser()))
    source = Path(source).expanduser().resolve()
    data_directory = Path(data_directory).expanduser().resolve()
    output = Path(output).expanduser().resolve()
    if not runtime.is_file() or not os.access(runtime, os.X_OK):
        raise ValueError(f"Python runtime is missing or not executable: {runtime}")
    if not source.is_file():
        raise ValueError(f"Study application source is missing: {source}")
    if output.exists():
        raise FileExistsError(f"Application already exists: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    template = SCRIPT.read_text(encoding="utf-8")
    script = template.replace("__RUNTIME__", _apple_string(runtime)).replace("__SOURCE__", _apple_string(source))
    with tempfile.TemporaryDirectory(prefix="tree-launcher-", dir=output.parent) as temporary:
        temporary_root = Path(temporary)
        script_path = temporary_root / "launcher.applescript"
        script_path.write_text(script, encoding="utf-8")
        compiled = temporary_root / output.name
        compiler(["/usr/bin/osacompile", "-o", str(compiled), str(script_path)], check=True, capture_output=True, text=True)
        if not compiled.is_dir():
            raise RuntimeError("Mac application compiler did not create the application bundle")
        information_path = compiled / "Contents" / "Info.plist"
        with information_path.open("rb") as metadata:
            information = plistlib.load(metadata)
        information.update({"CFBundleIdentifier": BUNDLE_IDENTIFIER,
                            "CFBundleName": BUNDLE_NAME, "CFBundleDisplayName": BUNDLE_NAME})
        with information_path.open("wb") as metadata:
            plistlib.dump(information, metadata)
        resources = compiled / "Contents" / "Resources"
        resources.mkdir(parents=True, exist_ok=True)
        manifest = {"runtime": str(runtime), "source": str(source), "data_directory": str(data_directory), "chrome_window_name": chrome_window_name}
        (resources / "installation.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", str(compiled)],
                       check=True, capture_output=True, text=True)
        if output.exists():
            raise FileExistsError(f"Application appeared while building: {output}")
        compiled.rename(output)
    return output


def main(arguments=None):
    parser = argparse.ArgumentParser(description="Build the double-click Lovefield Tree Study Mac application")
    parser.add_argument("--runtime", type=Path, default=Path(sys.executable))
    parser.add_argument("--source", type=Path, default=Path(__file__).parent.parent / "src" / "study_app.py")
    parser.add_argument("--data-directory", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--output", type=Path, default=Path.home() / "Applications" / "Lovefield Tree Study.app")
    parser.add_argument("--chrome-window-name", required=True)
    options = parser.parse_args(arguments)
    try:
        output = build_launcher(options.runtime, options.source, options.data_directory, options.output, chrome_window_name=options.chrome_window_name)
    except (ValueError, FileExistsError, OSError, RuntimeError, subprocess.CalledProcessError) as problem:
        parser.exit(2, f"Cannot build Mac application: {problem}\n")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
