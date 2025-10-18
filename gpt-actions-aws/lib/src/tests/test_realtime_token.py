import json
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib import error
import importlib.util
import sys
import uuid

import pytest


MODULE_PATH = Path(__file__).resolve().parent.parent / "realtime_token.py"


class DummyResponse:
    def __init__(self, payload: dict):
        self._payload = payload

    def read(self) -> bytes:
        return json.dumps(self._payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


def _load_module(monkeypatch, extra_env=None, bearer_secret="bearer", openai_secret="openai"):
    monkeypatch.setenv("SECRET_NAME", "arn:bearer")
    monkeypatch.setenv("OPENAI_API_KEY_SECRET_ARN", "arn:openai")
    if extra_env:
        for key, value in extra_env.items():
            if value is None:
                monkeypatch.delenv(key, raising=False)
            else:
                monkeypatch.setenv(key, value)

    secrets_client = Mock()

    def _get_secret_value(SecretId):
        if SecretId == "arn:bearer":
            return {"SecretString": bearer_secret}
        if SecretId == "arn:openai":
            return {"SecretString": openai_secret}
        raise AssertionError(f"Unexpected SecretId: {SecretId}")

    secrets_client.get_secret_value.side_effect = _get_secret_value

    module_name = f"realtime_token_module_{uuid.uuid4().hex}"
    spec = importlib.util.spec_from_file_location(module_name, MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    with patch("boto3.client", return_value=secrets_client):
        spec.loader.exec_module(module)  # type: ignore[arg-type]
    return module, secrets_client


def _dummy_event(method: str, body: dict | None = None, **kwargs):
    event = {
        "requestContext": {"http": {"method": method}},
        "body": None,
    }
    event.update(kwargs)
    if body is not None:
        event["body"] = json.dumps(body)
    return event


def _context():
    return SimpleNamespace(aws_request_id="req-123")


def test_options_preflight(monkeypatch):
    module, _ = _load_module(monkeypatch)
    event = {
        "requestContext": {"http": {"method": "OPTIONS"}},
        "body": None,
    }
    resp = module.handler(event, _context())
    assert resp["statusCode"] == 204
    for header in (
        "Access-Control-Allow-Origin",
        "Access-Control-Allow-Headers",
        "Access-Control-Allow-Methods",
        "Content-Type",
    ):
        assert header in resp["headers"]


def test_wrong_method_returns_405(monkeypatch):
    module, _ = _load_module(monkeypatch)
    event = {
        "requestContext": {"http": {"method": "GET"}},
        "body": None,
    }
    resp = module.handler(event, _context())
    assert resp["statusCode"] == 405
    assert json.loads(resp["body"]) == {"message": "Method Not Allowed"}


def test_empty_body_uses_env_model(monkeypatch):
    module, _ = _load_module(monkeypatch, extra_env={"REALTIME_MODEL": "env-model"})
    response_payload = {"session": {"id": "sess"}}
    urlopen_mock = Mock(return_value=DummyResponse(response_payload))
    monkeypatch.setattr(module.request, "urlopen", urlopen_mock)

    event = {
        "requestContext": {"http": {"method": "POST"}},
        "body": None,
    }
    resp = module.handler(event, _context())
    assert resp["statusCode"] == 200
    req_obj = urlopen_mock.call_args[0][0]
    sent_body = json.loads(req_obj.data.decode("utf-8"))
    assert sent_body["model"] == "env-model"
    assert sent_body["modalities"] == ["audio", "text"]


def test_bad_base64_treated_as_empty(monkeypatch):
    module, _ = _load_module(monkeypatch, extra_env={"REALTIME_MODEL": "env-model"})
    urlopen_mock = Mock(return_value=DummyResponse({"session": {}}))
    monkeypatch.setattr(module.request, "urlopen", urlopen_mock)

    event = {
        "requestContext": {"http": {"method": "POST"}},
        "body": "!!notbase64!!",
        "isBase64Encoded": True,
    }
    module.handler(event, _context())
    sent_body = json.loads(urlopen_mock.call_args[0][0].data.decode("utf-8"))
    assert sent_body["model"] == "env-model"


def test_expires_in_not_int(monkeypatch):
    module, _ = _load_module(monkeypatch)
    event = _dummy_event("POST", {"expires_in": "abc"})
    resp = module.handler(event, _context())
    assert resp["statusCode"] == 400
    assert "integer" in json.loads(resp["body"])["message"]


def test_expires_in_out_of_range(monkeypatch):
    module, _ = _load_module(monkeypatch)
    event = _dummy_event("POST", {"expires_in": 10})
    resp = module.handler(event, _context())
    assert resp["statusCode"] == 400
    assert "between 60 and 600" in json.loads(resp["body"])["message"]


def test_blank_model_falls_back(monkeypatch):
    module, _ = _load_module(monkeypatch, extra_env={"REALTIME_MODEL": "env-model"})
    urlopen_mock = Mock(return_value=DummyResponse({"session": {}}))
    monkeypatch.setattr(module.request, "urlopen", urlopen_mock)

    event = _dummy_event("POST", {"model": "   "})
    module.handler(event, _context())
    sent_body = json.loads(urlopen_mock.call_args[0][0].data.decode("utf-8"))
    assert sent_body["model"] == "env-model"


def test_http_error_logs_and_returns_502(monkeypatch):
    module, _ = _load_module(monkeypatch, extra_env={"REALTIME_MODEL": "env-model"})
    openai_url = module.OPENAI_SESSIONS_URL  # type: ignore[attr-defined]
    http_error = error.HTTPError(
        openai_url,
        500,
        "error",
        hdrs=None,
        fp=BytesIO(b"{\"details\":\"boom\"}"),
    )
    urlopen_mock = Mock(side_effect=http_error)
    monkeypatch.setattr(module.request, "urlopen", urlopen_mock)

    with patch.object(module.LOGGER, "error") as mock_error:
        resp = module.handler(_dummy_event("POST", {}), _context())

    assert resp["statusCode"] == 502
    assert mock_error.call_count == 1


def test_network_error_retries(monkeypatch):
    module, _ = _load_module(monkeypatch, extra_env={"REALTIME_MODEL": "env-model"})
    responses = [Exception("boom"), DummyResponse({"session": {}})]

    def side_effect(*args, **kwargs):
        result = responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    urlopen_mock = Mock(side_effect=side_effect)
    monkeypatch.setattr(module.request, "urlopen", urlopen_mock)

    resp = module.handler(_dummy_event("POST", {}), _context())
    assert resp["statusCode"] == 200
    assert urlopen_mock.call_count == 2


def test_happy_path(monkeypatch):
    module, _ = _load_module(monkeypatch)
    openai_payload = {"object": "realtime.session", "id": "sess"}
    urlopen_mock = Mock(return_value=DummyResponse(openai_payload))
    monkeypatch.setattr(module.request, "urlopen", urlopen_mock)

    resp = module.handler(_dummy_event("POST", {"instructions": "be nice"}), _context())
    assert resp["statusCode"] == 200
    parsed = json.loads(resp["body"])
    assert parsed == {"ok": True, "session": openai_payload}
    req_obj = urlopen_mock.call_args[0][0]
    assert req_obj.headers["OpenAI-Beta"] == "realtime=v1"
    sent_body = json.loads(req_obj.data.decode("utf-8"))
    assert sent_body["model"] == module.DEFAULT_REALTIME_MODEL
    assert sent_body["modalities"] == ["audio", "text"]


def test_transcription_config_forwarded(monkeypatch):
    module, _ = _load_module(monkeypatch)
    openai_payload = {"object": "realtime.session", "id": "sess"}
    urlopen_mock = Mock(return_value=DummyResponse(openai_payload))
    monkeypatch.setattr(module.request, "urlopen", urlopen_mock)

    payload = {
        "instructions": "test",
        "input_audio_transcription": {"model": "gpt-4o-transcribe"},
    }

    resp = module.handler(_dummy_event("POST", payload), _context())
    assert resp["statusCode"] == 200
    sent_body = json.loads(urlopen_mock.call_args[0][0].data.decode("utf-8"))
    assert sent_body["input_audio_transcription"] == payload["input_audio_transcription"]
