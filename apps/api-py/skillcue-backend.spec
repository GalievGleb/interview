# PyInstaller spec for the SkillCue backend.
#
#   cd apps/api-py
#   pip install pyinstaller
#   pyinstaller skillcue-backend.spec
#
# Produces `dist/skillcue-backend/` (onedir) which electron-builder ships under
# `resources/backend/` (see apps/desktop/package.json → build.extraResources).
# The Electron main process spawns `skillcue-backend(.exe)` in packaged mode.
#
# NOTE: faster-whisper / ctranslate2 bundle native libs + data; collect_all below
# covers the common cases but may need per-machine tuning (e.g. CUDA libs). The
# Whisper model files themselves are downloaded at runtime into the user cache,
# not bundled here.

import os

from PyInstaller.utils.hooks import collect_all, collect_submodules

datas: list = []
binaries: list = []
hiddenimports: list = []

# Python Knowledge Pack runtime data (parsed records; NOT the raw source md).
_pack_rel = os.path.join("app", "knowledge", "packs", "python_interview_questions")
for _fn in ("index.json", "answers.json", "metadata.json"):
    _src = os.path.join(_pack_rel, _fn)
    if os.path.exists(_src):
        datas.append((_src, _pack_rel))

for pkg in ("faster_whisper", "ctranslate2", "tokenizers", "onnxruntime", "av", "huggingface_hub"):
    try:
        pkg_datas, pkg_binaries, pkg_hidden = collect_all(pkg)
        datas += pkg_datas
        binaries += pkg_binaries
        hiddenimports += pkg_hidden
    except Exception:  # noqa: BLE001 — a missing optional package shouldn't abort the build
        pass

hiddenimports += collect_submodules("uvicorn")
hiddenimports += collect_submodules("app")
hiddenimports += ["app.main"]

a = Analysis(
    ["run_server.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="skillcue-backend",
    console=True,
    disable_windowed_traceback=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="skillcue-backend",
)
