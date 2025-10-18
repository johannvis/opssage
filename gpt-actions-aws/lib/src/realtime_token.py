"""Lambda function that mints OpenAI realtime session tokens for authorised callers."""

from __future__ import annotations

import base64
import json
import logging
import os
from typing import Any, Dict
from urllib import error, request

try:
    import boto3  # type: ignore
except ModuleNotFoundError:  # pragma: no cover - exercised via tests
    boto3 = None  # type: ignore[assignment]

LOGGER = logging.getLogger(__name__)
LOGGER.setLevel(logging.INFO)

_SECRETS_CLIENT: Any | None = None
_SECRET_CACHE: Dict[str, str] = {}

if boto3 is not None:
    try:
        _SECRETS_CLIENT = boto3.client("secretsmanager")
    except ModuleNotFoundError:
        _SECRETS_CLIENT = None

OPENAI_SESSIONS_URL = "https://api.openai.com/v1/realtime/sessions"
DEFAULT_REALTIME_MODEL = "gpt-4o-mini-realtime-preview"
DEFAULT_TIMEOUT_SECONDS = 8
MAX_RETRIES = 1

CORS_HEADERS = {
    "Access-Control-Allow-Origin": os.environ.get("CORS_ALLOW_ORIGIN", "*"),
    "Access-Control-Allow-Headers": "authorization,content-type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Content-Type": "application/json",
}


def _cors(status: int, body: Dict[str, Any]) -> Dict[str, Any]:
    """Return a Lambda proxy response with CORS headers."""
    return {
        "statusCode": status,
        "headers": CORS_HEADERS,
        "body": json.dumps(body, separators= (",", ":")),
    }


def _resolve_secrets_client() -> Any:
    """Lazily construct the AWS Secrets Manager client to keep boto3 optional in tests."""
    global _SECRETS_CLIENT
    if _SECRETS_CLIENT is not None:
        return _SECRETS_CLIENT

    if boto3 is None:
        raise ModuleNotFoundError(
            "boto3 is required to fetch secrets. Install boto3 in the deployment environment."
        )

    _SECRETS_CLIENT = boto3.client("secretsmanager")
    return _SECRETS_CLIENT


def _get_secret(secret_arn: str) -> str:
    """Fetch and memoise the raw secret string."""
    client = _resolve_secrets_client()
    if secret_arn in _SECRET_CACHE:
        return _SECRET_CACHE[secret_arn]

    response = client.get_secret_value(SecretId=secret_arn)
    secret = response.get("SecretString")
    if secret is None:
        raise RuntimeError(f"Secret {secret_arn} does not contain a SecretString payload")

    _SECRET_CACHE[secret_arn] = secret
    return secret


def _decode_body(event: Dict[str, Any]) -> Dict[str, Any]:
    """Return the JSON payload supplied with the request, defaulting to an empty dict."""
    body = event.get("body")
    if not body:
        return {}

    if event.get("isBase64Encoded"):
        try:
            body = base64.b64decode(body).decode("utf-8")
        except Exception:
            return {}

    try:
        parsed = json.loads(body)
    except (TypeError, ValueError):
        return {}

    return parsed if isinstance(parsed, dict) else {}


def _sanitize_model(requested: Any) -> str:
    """Resolve the model name by preference order and ensure a non-empty string."""
    candidate = requested or os.environ.get("REALTIME_MODEL") or DEFAULT_REALTIME_MODEL
    if isinstance(candidate, str):
        candidate = candidate.strip()
    else:
        candidate = DEFAULT_REALTIME_MODEL

    if not candidate:
        return DEFAULT_REALTIME_MODEL
    return candidate


def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """Handle HTTP API invocations and return the realtime client token."""
    method = (
        event.get("requestContext", {})
        .get("http", {})
        .get("method", "")
        .upper()
    )

    if method == "OPTIONS":
        return _cors(204, {})

    if method != "POST":
        return _cors(405, {"message": "Method Not Allowed"})

    body = _decode_body(event)
    instructions = body.get("instructions")
    voice = body.get("voice")
    expires_in = body.get("expires_in")
    requested_model = body.get("model")

    if expires_in is not None:
        try:
            expires_in = int(expires_in)
        except (TypeError, ValueError):
            return _cors(400, {"message": "expires_in must be an integer"})

        if expires_in < 60 or expires_in > 600:
            return _cors(400, {"message": "expires_in must be between 60 and 600 seconds"})

    bearer_secret_arn = os.environ["SECRET_NAME"]
    openai_secret_arn = os.environ["OPENAI_API_KEY_SECRET_ARN"]

    try:
        bearer_token = _get_secret(bearer_secret_arn)
        openai_api_key = _get_secret(openai_secret_arn)
    except Exception:  # pragma: no cover - defensive runtime guard
        LOGGER.exception("Failed to load secrets")
        return _cors(500, {"message": "Failed to load secrets"})

    model = _sanitize_model(requested_model)

    session_payload: Dict[str, Any] = {
        "model": model,
        "modalities": ["audio", "text"],
    }

    if instructions:
        session_payload["instructions"] = instructions
    if voice:
        session_payload["voice"] = voice
    if expires_in is not None:
        session_payload["expires_in"] = expires_in

    request_id = getattr(context, "aws_request_id", "")

    LOGGER.info(
        json.dumps(
            {
                "level": "info",
                "msg": "request_openai_session",
                "model": model,
                "requestId": request_id,
            },
            separators=(",", ":"),
        )
    )

    payload_bytes = json.dumps(session_payload, separators=(",", ":")).encode("utf-8")

    last_exception: Exception | None = None
    attempts = 0

    while attempts <= MAX_RETRIES:
        try:
            req = request.Request(
                OPENAI_SESSIONS_URL,
                data=payload_bytes,
                headers={
                    "Authorization": f"Bearer {openai_api_key}",
                    "Content-Type": "application/json",
                    "OpenAI-Beta": "realtime=v1",
                },
                method="POST",
            )

            with request.urlopen(req, timeout=DEFAULT_TIMEOUT_SECONDS) as resp:
                openai_payload = json.loads(resp.read().decode("utf-8"))

            LOGGER.info(
                json.dumps(
                    {
                        "level": "info",
                        "msg": "realtime_session_created",
                        "model": model,
                        "requestId": request_id,
                    },
                    separators=(",", ":"),
                )
            )

            return _cors(200, {"ok": True, "session": openai_payload})

        except error.HTTPError as http_err:  # pragma: no cover - exercised in tests
            raw = http_err.read().decode("utf-8", "ignore")[:2000] if hasattr(http_err, "read") else ""
            LOGGER.error(
                json.dumps(
                    {
                        "level": "error",
                        "msg": "openai_realtime_session_error",
                        "status": getattr(http_err, "code", None),
                        "model": model,
                        "err": raw,
                        "requestId": request_id,
                    },
                    separators=(",", ":"),
                )
            )
            return _cors(502, {"message": "Failed to create realtime session"})
        except Exception as exc:  # pragma: no cover - exercised in tests
            last_exception = exc
            if attempts < MAX_RETRIES:
                attempts += 1
                continue
            LOGGER.exception("Unexpected error during realtime session request")
            return _cors(502, {"message": "Failed to create realtime session"})

    if last_exception:  # pragma: no cover - safety
        LOGGER.exception("Unexpected error during realtime session request")
    return _cors(502, {"message": "Failed to create realtime session"})
