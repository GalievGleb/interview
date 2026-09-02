"""Owned backend process cleanup shared by source-backed verification tools."""

from __future__ import annotations

import json
import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class _WindowsProcessIdentity:
    pid: int
    creation_ticks: int


@dataclass(frozen=True)
class _WindowsProcessSnapshot:
    pid: int
    parent_pid: int
    creation_ticks: int

    @property
    def identity(self) -> _WindowsProcessIdentity:
        return _WindowsProcessIdentity(self.pid, self.creation_ticks)


def _windows_process_snapshot() -> dict[int, _WindowsProcessSnapshot]:
    if os.name != "nt":
        return {}
    script = """
$items = @(Get-CimInstance Win32_Process | ForEach-Object {
    [pscustomobject]@{
        pid = [int]$_.ProcessId
        parent_pid = [int]$_.ParentProcessId
        creation_ticks = [long]$_.CreationDate.ToUniversalTime().Ticks
    }
})
ConvertTo-Json -InputObject $items -Compress
""".strip()
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", script],
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        raw = json.loads(result.stdout)
        items = raw if isinstance(raw, list) else [raw]
        return {
            item.pid: item
            for item in (
                _WindowsProcessSnapshot(
                    pid=int(value["pid"]),
                    parent_pid=int(value["parent_pid"]),
                    creation_ticks=int(value["creation_ticks"]),
                )
                for value in items
                if isinstance(value, dict)
            )
        }
    except (
        OSError,
        ValueError,
        KeyError,
        json.JSONDecodeError,
        subprocess.SubprocessError,
    ):
        return {}


class OwnedProcessTree:
    """Tracks a backend launcher and only identity-matching descendants."""

    def __init__(self, root: _WindowsProcessIdentity) -> None:
        self.root = root
        self._known: set[_WindowsProcessIdentity] = {root}

    @classmethod
    def capture(cls, root_pid: int) -> OwnedProcessTree:
        root = _windows_process_snapshot().get(root_pid)
        if root is None:
            raise RuntimeError("Backend launcher process was not found")
        return cls(root.identity)

    def current_processes(self) -> list[_WindowsProcessSnapshot]:
        snapshots = _windows_process_snapshot()
        owned = {
            identity.pid: current
            for identity in self._known
            if (current := snapshots.get(identity.pid)) is not None
            and current.identity == identity
        }
        changed = True
        while changed:
            changed = False
            for candidate in snapshots.values():
                parent = owned.get(candidate.parent_pid)
                if (
                    candidate.pid in owned
                    or parent is None
                    or candidate.pid == candidate.parent_pid
                ):
                    continue
                if candidate.creation_ticks < parent.creation_ticks:
                    continue
                owned[candidate.pid] = candidate
                self._known.add(candidate.identity)
                changed = True
        return list(owned.values())


def _stop_windows_processes(processes: list[_WindowsProcessSnapshot]) -> None:
    if not processes:
        return
    by_pid = {item.pid: item for item in processes}

    def depth(item: _WindowsProcessSnapshot) -> int:
        result = 0
        current = item
        seen: set[int] = set()
        while current.parent_pid in by_pid and current.parent_pid not in seen:
            seen.add(current.parent_pid)
            current = by_pid[current.parent_pid]
            result += 1
        return result

    ordered = sorted(processes, key=depth, reverse=True)
    targets = ",".join(
        f"@{{pid={item.pid};ticks={item.creation_ticks}}}" for item in ordered
    )
    script = f"""
$targets = @({targets})
foreach ($target in $targets) {{
    $current = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $target.pid) -ErrorAction SilentlyContinue
    if ($null -ne $current -and [long]$current.CreationDate.ToUniversalTime().Ticks -eq [long]$target.ticks) {{
        Stop-Process -Id $target.pid -Force -ErrorAction SilentlyContinue
    }}
}}
""".strip()
    subprocess.run(
        ["powershell", "-NoProfile", "-Command", script],
        check=False,
        capture_output=True,
        text=True,
        timeout=15,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def terminate_owned_process_tree(
    process: subprocess.Popen, tree: OwnedProcessTree | None
) -> None:
    """Terminate only the captured identity-matching tree; never trust PID reuse."""
    if os.name == "nt" and tree is not None:
        _stop_windows_processes(tree.current_processes())
    elif process.poll() is None:
        process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def remove_sqlite_artifacts(path: Path, *, attempts: int = 10) -> bool:
    for attempt in range(max(1, attempts)):
        blocked = False
        for target in (path, Path(f"{path}-wal"), Path(f"{path}-shm")):
            try:
                target.unlink(missing_ok=True)
            except PermissionError:
                blocked = True
        if not blocked:
            return True
        if attempt + 1 < attempts:
            time.sleep(min(0.5, 0.05 * (attempt + 1)))
    return False
