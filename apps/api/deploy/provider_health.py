#!/usr/bin/env python3
"""SkillCue managed-provider readiness check without spending LLM tokens."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path
from urllib.parse import urlparse


def _known_upstream_style(upstream_base: str) -> str:
    hostname = (urlparse(upstream_base.strip()).hostname or "").lower()
    if hostname == "openrouter.ai":
        return "openrouter"
    if hostname == "api.openai.com":
        return "openai"
    return ""


def evaluate_provider(
    *,
    upstream_base: str,
    upstream_style: str = "",
    key_prefix: str,
    total_credits: float,
    total_usage: float,
    warning_threshold: float,
) -> tuple[bool, str]:
    normalized_base = upstream_base.strip().lower().rstrip("/")
    normalized_style = upstream_style.strip().lower()
    known_style = _known_upstream_style(upstream_base)
    if known_style and normalized_style and normalized_style != known_style:
        hostname = urlparse(upstream_base.strip()).hostname or upstream_base
        return (
            False,
            f"Gateway upstream style mismatch: {hostname} requires {known_style}, got {normalized_style}",
        )
    if key_prefix.startswith("sk-or-v1-") and "openrouter.ai" not in normalized_base:
        return False, "OpenRouter key is routed to a non-OpenRouter upstream"

    remaining = max(0.0, float(total_credits) - float(total_usage))
    if remaining < float(warning_threshold):
        return False, f"OpenRouter balance is low: ${remaining:.2f} remaining"
    return True, f"OpenRouter ready: ${remaining:.2f} remaining"


def evaluate_compatible_upstream(
    *, upstream_base: str, upstream_style: str, key_prefix: str
) -> tuple[bool, str]:
    """Validate a non-OpenRouter compatible upstream without pretending to know its balance."""
    parsed = urlparse(upstream_base.strip())
    hostname = (parsed.hostname or "").lower()
    if parsed.scheme.lower() != "https" or not hostname:
        return False, "Compatible upstream requires a valid HTTPS URL"
    known_style = _known_upstream_style(upstream_base)
    normalized_style = upstream_style.strip().lower()
    if known_style and normalized_style and normalized_style != known_style:
        return (
            False,
            f"Gateway upstream style mismatch: {hostname} requires {known_style}, got {normalized_style}",
        )
    if key_prefix.startswith("sk-or-v1-") and hostname != "openrouter.ai":
        return False, "OpenRouter key is routed to a non-OpenRouter upstream"
    if normalized_style not in {"openai", "openrouter"}:
        return False, "Compatible upstream style must be openai or openrouter"
    return (
        True,
        f"Compatible upstream configured: {hostname} (balance check unavailable)",
    )


def evaluate_openai_chat_readiness(environment: dict[str, str]) -> tuple[bool, str]:
    """Report optional direct-chat readiness without returning credential material."""
    dedicated_key = environment.get("OPENAI_CHAT_API_KEY", "").strip()
    dedicated_base = environment.get("OPENAI_CHAT_BASE_URL", "").strip()
    if dedicated_base and not dedicated_key:
        return False, "OpenAI direct chat partial configuration (key is missing)"
    legacy_key = environment.get("OPENAI_API_KEY", "").strip()
    api_key = dedicated_key or legacy_key
    base_url = (
        (dedicated_base or "https://api.openai.com/v1")
        if dedicated_key
        else (
            environment.get("OPENAI_STT_BASE_URL", "").strip()
            or "https://api.openai.com/v1"
        )
    )
    if not api_key:
        return False, "OpenAI direct chat not configured (managed fallback only)"
    hostname = (urlparse(base_url).hostname or "").lower()
    if hostname != "api.openai.com" or not base_url.lower().startswith("https://"):
        return False, "OpenAI direct chat unavailable (official HTTPS base required)"
    if dedicated_key:
        return True, "OpenAI direct chat ready (isolated api.openai.com credentials)"
    return True, "OpenAI direct chat ready (legacy shared STT credentials)"


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
        raise TypeError("OpenRouter returned malformed credits data")
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
        upstream_style = env.get("GATEWAY_UPSTREAM_STYLE", "")
        if not api_key:
            raise RuntimeError("OPENROUTER_API_KEY is missing")
        known_upstream_style = _known_upstream_style(upstream)
        if known_upstream_style != "openrouter":
            ok, message = evaluate_compatible_upstream(
                upstream_base=upstream,
                upstream_style=upstream_style,
                key_prefix="sk-or-v1-" if api_key.startswith("sk-or-v1-") else "other",
            )
        else:
            total_credits, total_usage = _openrouter_credits(api_key)
            ok, message = evaluate_provider(
                upstream_base=upstream,
                upstream_style=upstream_style,
                key_prefix="sk-or-v1-" if api_key.startswith("sk-or-v1-") else "other",
                total_credits=total_credits,
                total_usage=total_usage,
                warning_threshold=args.warning_threshold,
            )
        chat_ok, chat_message = evaluate_openai_chat_readiness(env)
        chat_required = env.get("OPENAI_CHAT_REQUIRED", "").strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }
        chat_explicitly_configured = bool(
            env.get("OPENAI_CHAT_API_KEY", "").strip()
            or env.get("OPENAI_CHAT_BASE_URL", "").strip()
        )
        print(message)
        print(chat_message)
        return (
            0
            if ok and (chat_ok or not (chat_required or chat_explicitly_configured))
            else 1
        )
    except (OSError, RuntimeError, TypeError, ValueError) as exc:
        print(f"Provider readiness failed: {type(exc).__name__}: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
