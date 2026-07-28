# PyInstaller spec for the SkillCue desktop backend.

import os

from PyInstaller.utils.hooks import collect_submodules

datas: list = []

# Python Knowledge Pack runtime data (parsed records; not the source markdown).
_packs_root = os.path.join("app", "knowledge", "packs")
for _pack in os.listdir(_packs_root) if os.path.isdir(_packs_root) else []:
    _pack_rel = os.path.join(_packs_root, _pack)
    for _fn in ("index.json", "answers.json", "metadata.json", "curated.json"):
        _src = os.path.join(_pack_rel, _fn)
        if os.path.exists(_src):
            datas.append((_src, _pack_rel))

hiddenimports = collect_submodules("uvicorn") + collect_submodules("app") + ["app.main"]

a = Analysis(
    ["run_server.py"],
    pathex=["."],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=[
        "onnxruntime",
        "torch",
        "transformers",
    ],
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
