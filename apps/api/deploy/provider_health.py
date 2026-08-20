#!/usr/bin/env python3
"""SkillCue managed-provider readiness check without spending LLM tokens."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path


def evaluate_provider(
    *,
    upstream_base: str,
    key_prefix: str,
    total_credits: float,
    total_usage: float,
    warning_threshold: float,
) -> tuple[bool, str]:
    normalized_base = upstream_base.strip().lower().rstrip("/")
    if key_prefix.startswith("sk-or-v1-") and "openrouter.ai" not in normalized_base:
        return False, "OpenRouter key is routed to a non-OpenRouter upstream"

    remaining = max(0.0, float(total_credits) - float(total_usage))
    if remaining < float(warning_threshold):
        return False, f"OpenRouter balance is low: ${remaining:.2f} remaining"
    return True, f"OpenRouter ready: ${remaining:.2f} remaining"


def _read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        values[name.strip()] = value.strip()
    return values


def _openrouter_credits(api_key: str, timeout: int = 15) -> tuple[float, float]:
    request = urllib.request.Request(
        "https://openrouter.ai/api/v1/credits",
        headers={"Authorization": f"Bearer {api_key}"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.load(response)
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        raise RuntimeError("OpenRouter returned malformed credits data")
    return float(data.get("total_credits") or 0), float(data.get("total_usage") or 0)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env", default="/opt/skillcue/gateway.env")
    parser.add_argument("--warning-threshold", type=float, default=1.0)
    args = parser.parse_args()

    try:
        env = _read_env(Path(args.env))
        api_key = env.get("OPENROUTER_API_KEY", "")
        upstream = env.get("GATEWAY_UPSTREAM_BASE", "https://openrouter.ai/api/v1")
        if not api_key:
            raise RuntimeError("OPENROUTER_API_KEY is missing")
        if api_key.startswith("sk-or-v1-") and "openrouter.ai" not in upstream.lower():
            ok, message = evaluate_provider(
                upstream_base=upstream,
                key_prefix="sk-or-v1-",
                total_credits=0,
                total_usage=0,
                warning_threshold=args.warning_threshold,
            )
        else:
            total_credits, total_usage = _openrouter_credits(api_key)
            ok, message = evaluate_provider(
                upstream_base=upstream,
                key_prefix="sk-or-v1-" if api_key.startswith("sk-or-v1-") else "other",
                total_credits=total_credits,
                total_usage=total_usage,
                warning_threshold=args.warning_threshold,
            )
        print(message)
        return 0 if ok else 1
    except Exception as exc:
        print(f"Provider readiness failed: {type(exc).__name__}: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
