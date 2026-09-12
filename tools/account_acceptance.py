#!/usr/bin/env python3
"""Privacy-safe live acceptance for the isolated SkillCue account API.

Use a dedicated verified test account. The password is read only from
SKILLCUE_ACCEPTANCE_PASSWORD and is never written to the report.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Protocol

SENSITIVE_KEYS = {
    "password",
    "code",
    "idtoken",
    "accesstoken",
    "refreshtoken",
    "authorization",
    "key",
}


class AccountHttpError(RuntimeError):
    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status = status
        self.code = code


def extract_error_code(payload: object) -> str:
    if not isinstance(payload, dict):
        return "ACCOUNT_REQUEST_FAILED"
    code = payload.get("code")
    if isinstance(code, str):
        return code
    message = payload.get("message")
    if isinstance(message, str):
        return message
    if isinstance(message, dict):
        return extract_error_code(message)
    return "ACCOUNT_REQUEST_FAILED"


def redact_report(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: "[REDACTED]" if key.lower() in SENSITIVE_KEYS else redact_report(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_report(item) for item in value]
    return value


class AccountApiProtocol(Protocol):
    def login(self, email: str, password: str, device_id: str, device_name: str) -> dict[str, Any]: ...
    def refresh(self, refresh_token: str) -> dict[str, Any]: ...
    def devices(self, access_token: str) -> list[dict[str, Any]]: ...
    def revoke(self, access_token: str, session_id: str) -> dict[str, Any]: ...
    def subscription(self, access_token: str) -> dict[str, Any]: ...
    def managed_license(self, access_token: str) -> dict[str, Any]: ...
    def logout(self, access_token: str) -> dict[str, Any]: ...


class AccountApi:
    def __init__(self, base_url: str, timeout: float = 15.0):
        if not base_url.startswith("https://") and not base_url.startswith("http://127.0.0.1"):
            raise ValueError("Account acceptance requires HTTPS or a loopback development URL")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def health(self) -> dict[str, Any]:
        return self._request("GET", "/health")

    def register(self, email: str, password: str, device_id: str, device_name: str) -> dict[str, Any]:
        return self._request("POST", "/auth/register", {
            "email": email, "password": password, "deviceId": device_id, "deviceName": device_name,
        })

    def verify_email(self, email: str, code: str, device_id: str, device_name: str) -> dict[str, Any]:
        return self._request("POST", "/auth/verify-email", {
            "email": email, "code": code, "deviceId": device_id, "deviceName": device_name,
        })

    def login(self, email: str, password: str, device_id: str, device_name: str) -> dict[str, Any]:
        return self._request("POST", "/auth/login", {
            "email": email, "password": password, "deviceId": device_id, "deviceName": device_name,
        })

    def refresh(self, refresh_token: str) -> dict[str, Any]:
        return self._request("POST", "/auth/refresh", {"refreshToken": refresh_token})

    def devices(self, access_token: str) -> list[dict[str, Any]]:
        result = self._request("GET", "/auth/devices", access_token=access_token)
        if not isinstance(result, list):
            raise AccountHttpError(500, "ACCOUNT_RESPONSE_INVALID")
        return result

    def revoke(self, access_token: str, session_id: str) -> dict[str, Any]:
        return self._request("DELETE", f"/auth/devices/{session_id}", access_token=access_token)

    def subscription(self, access_token: str) -> dict[str, Any]:
        return self._request("GET", "/subscriptions/me", access_token=access_token)

    def managed_license(self, access_token: str) -> dict[str, Any]:
        return self._request("GET", "/subscriptions/license", access_token=access_token)

    def logout(self, access_token: str) -> dict[str, Any]:
        return self._request("POST", "/auth/logout", {}, access_token=access_token)

    def _request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        access_token: str | None = None,
    ) -> Any:
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {
            "Accept": "application/json",
            "User-Agent": "SkillCue-Account-Acceptance/0.1.13",
        }
        if data is not None:
            headers["Content-Type"] = "application/json"
        if access_token:
            headers["Authorization"] = f"Bearer {access_token}"
        request = urllib.request.Request(
            f"{self.base_url}{path}", data=data, headers=headers, method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            try:
                payload = json.loads(error.read().decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                payload = {}
            raise AccountHttpError(error.code, extract_error_code(payload)) from None
        except urllib.error.URLError as error:
            raise AccountHttpError(0, "ACCOUNT_NETWORK_ERROR") from error
        try:
            return json.loads(raw) if raw else {}
        except ValueError as error:
            raise AccountHttpError(500, "ACCOUNT_RESPONSE_INVALID") from error


def _tokens(response: dict[str, Any]) -> tuple[str, str]:
    tokens = response.get("tokens")
    if not isinstance(tokens, dict):
        raise AccountHttpError(500, "ACCOUNT_RESPONSE_INVALID")
    access = tokens.get("accessToken")
    refresh = tokens.get("refreshToken")
    if not isinstance(access, str) or not isinstance(refresh, str):
        raise AccountHttpError(500, "ACCOUNT_RESPONSE_INVALID")
    return access, refresh


def run_device_acceptance(
    api: AccountApiProtocol,
    email: str,
    password: str,
    repetitions: int = 10,
) -> dict[str, Any]:
    if repetitions < 1:
        raise ValueError("repetitions must be positive")
    passes: list[dict[str, Any]] = []
    for index in range(repetitions):
        run_id = uuid.uuid4().hex
        name_a = f"Acceptance {index + 1} A"
        name_b = f"Acceptance {index + 1} B"
        name_c = f"Acceptance {index + 1} C"
        response_a = api.login(email, password, f"acceptance-{run_id}-a", name_a)
        access_a, refresh_a = _tokens(response_a)
        response_b = api.login(email, password, f"acceptance-{run_id}-b", name_b)
        access_b, refresh_b = _tokens(response_b)
        rotated = api.refresh(refresh_b)
        access_b_rotated, refresh_b_rotated = _tokens(rotated)
        if refresh_b_rotated == refresh_b:
            raise AssertionError("refresh token was not rotated")

        third_rejected = False
        try:
            api.login(email, password, f"acceptance-{run_id}-c", name_c)
        except AccountHttpError as error:
            third_rejected = error.status == 409 and error.code == "DEVICE_LIMIT_REACHED"
        if not third_rejected:
            raise AssertionError("third device was not rejected")

        devices = api.devices(access_a)
        b_device = next((item for item in devices if item.get("name") == name_b), None)
        if not b_device or not isinstance(b_device.get("id"), str):
            raise AssertionError("second device is absent from the device list")
        api.revoke(access_a, b_device["id"])

        response_c = api.login(email, password, f"acceptance-{run_id}-c", name_c)
        access_c, _ = _tokens(response_c)
        subscription = api.subscription(access_c)
        if not isinstance(subscription, dict) or "status" not in subscription:
            raise AssertionError("subscription is not visible through the account API")
        managed = api.managed_license(access_c)
        expected_managed = subscription.get("status") == "ACTIVE"
        if not isinstance(managed, dict) or managed.get("active") is not expected_managed:
            raise AssertionError("managed desktop entitlement disagrees with the subscription")
        if expected_managed and not str(managed.get("key") or "").startswith("SKILLCUE-"):
            raise AssertionError("active subscription did not produce a signed desktop entitlement")

        api.logout(access_c)
        api.logout(access_a)
        passes.append({
            "index": index + 1,
            "thirdDeviceRejected": third_rejected,
            "refreshRotated": access_b_rotated != access_b or refresh_b_rotated != refresh_b,
            "deviceCountBeforeRevoke": len(devices),
            "subscriptionStatus": subscription.get("status"),
            "managedLicenseActive": managed.get("active"),
        })
        del refresh_a
    return {"passed": True, "repetitions": repetitions, "passes": passes}


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="SkillCue account API acceptance")
    parser.add_argument("--base-url", default="https://skill-cue.ru/account")
    parser.add_argument("--email", default=os.environ.get("SKILLCUE_ACCEPTANCE_EMAIL", ""))
    parser.add_argument("--repetitions", type=int, default=10)
    parser.add_argument("--report", type=Path, default=Path("output/account-acceptance.json"))
    parser.add_argument("--register", action="store_true", help="create and verify the dedicated test account first")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    password = os.environ.get("SKILLCUE_ACCEPTANCE_PASSWORD", "")
    if not args.email or not password:
        print("Set SKILLCUE_ACCEPTANCE_EMAIL and SKILLCUE_ACCEPTANCE_PASSWORD.", file=sys.stderr)
        return 2
    api = AccountApi(args.base_url)
    health = api.health()
    if health.get("ok") is not True:
        print("Account API health check failed.", file=sys.stderr)
        return 1
    if args.register:
        device_id = f"acceptance-register-{uuid.uuid4().hex}"
        api.register(args.email, password, device_id, "Acceptance registration")
        code = getpass.getpass("Код подтверждения из письма: ").strip()
        verified = api.verify_email(args.email, code, device_id, "Acceptance registration")
        access, _ = _tokens(verified)
        api.logout(access)

    try:
        report = run_device_acceptance(api, args.email, password, args.repetitions)
    except (AccountHttpError, AssertionError, ValueError) as error:
        print(f"Acceptance failed: {error}", file=sys.stderr)
        return 1
    safe_report = redact_report({"health": health, **report})
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(safe_report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Account acceptance passed {args.repetitions}/{args.repetitions}; report: {args.report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
