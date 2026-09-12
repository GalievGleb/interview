import json
import urllib.request

from tools.account_acceptance import (
    AccountApi,
    AccountHttpError,
    extract_error_code,
    redact_report,
    run_device_acceptance,
)


def test_account_http_client_uses_skillcue_user_agent(monkeypatch):
    seen: dict[str, str | None] = {}

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self):
            return json.dumps({"ok": True}).encode()

    def fake_urlopen(request, timeout):
        del timeout
        seen["user_agent"] = request.get_header("User-agent")
        return Response()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

    assert AccountApi("https://skill-cue.ru/account").health() == {"ok": True}
    assert seen["user_agent"] == "SkillCue-Account-Acceptance/0.1.13"


class FakeAccountApi:
    def __init__(self):
        self.sessions: dict[str, dict[str, str]] = {}
        self.login_attempts = 0

    def login(self, email: str, password: str, device_id: str, device_name: str):
        del email, password
        self.login_attempts += 1
        if device_id not in self.sessions and len(self.sessions) >= 2:
            raise AccountHttpError(409, "DEVICE_LIMIT_REACHED")
        session = {
            "id": f"session-{device_id}",
            "name": device_name,
            "accessToken": f"access-{device_id}",
            "refreshToken": f"refresh-{device_id}",
        }
        self.sessions[device_id] = session
        return {"tokens": session, "user": {"email": "qa@example.com"}}

    def refresh(self, refresh_token: str):
        device_id = refresh_token.removeprefix("refresh-")
        session = self.sessions[device_id]
        session["refreshToken"] = f"refresh2-{device_id}"
        return {"tokens": session}

    def devices(self, access_token: str):
        del access_token
        return [
            {"id": item["id"], "name": item["name"]}
            for item in self.sessions.values()
        ]

    def revoke(self, access_token: str, session_id: str):
        del access_token
        for device_id, item in list(self.sessions.items()):
            if item["id"] == session_id:
                del self.sessions[device_id]
                return {"revoked": True}
        raise AssertionError("unknown session")

    def subscription(self, access_token: str):
        del access_token
        return {"status": "EXPIRED", "plan": None}

    def managed_license(self, access_token: str):
        del access_token
        return {"active": False, "key": None, "expiresAt": None}

    def logout(self, access_token: str):
        for device_id in list(self.sessions):
            if self.sessions[device_id]["accessToken"] == access_token:
                del self.sessions[device_id]
        return {"revoked": True}


def test_ten_passes_cover_two_devices_rotation_and_third_device_rejection():
    api = FakeAccountApi()

    report = run_device_acceptance(api, "qa@example.com", "not-logged", repetitions=10)

    assert report["passed"] is True
    assert len(report["passes"]) == 10
    assert all(item["thirdDeviceRejected"] for item in report["passes"])
    assert api.sessions == {}
    assert api.login_attempts == 40


def test_reports_redact_credentials_recursively():
    report = redact_report({
        "accessToken": "secret-a",
        "nested": {
            "refreshToken": "secret-r",
            "password": "secret-p",
            "key": "SKILLCUE-secret",
            "ok": True,
        },
    })

    assert report == {
        "accessToken": "[REDACTED]",
        "nested": {
            "refreshToken": "[REDACTED]",
            "password": "[REDACTED]",
            "key": "[REDACTED]",
            "ok": True,
        },
    }


def test_nested_nest_error_code_is_stable():
    assert extract_error_code({"message": {"code": "DEVICE_LIMIT_REACHED"}}) == "DEVICE_LIMIT_REACHED"
    assert extract_error_code({"message": ["email must be an email"]}) == "ACCOUNT_REQUEST_FAILED"
