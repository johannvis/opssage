"""Lambda function that mints OpenAI realtime session tokens for authorised callers."""

from __future__ import annotations

import base64
import json
import logging
import os
from typing import Any, Dict
from urllib import error, request

import boto3

LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)

_SECRETS_CLIENT = boto3.client("secretsmanager")
_SECRET_CACHE: Dict[str, str] = {}

OPENAI_RT_ENDPOINT_TEMPLATE = "https://api.openai.com/v1/realtime/sessions?model={model}"
DEFAULT_TIMEOUT_SECONDS = 10


def _get_secret(secret_arn: str) -> str:
    """Fetch and memoise the raw secret string."""
    if secret_arn in _SECRET_CACHE:
        return _SECRET_CACHE[secret_arn]

    response = _SECRETS_CLIENT.get_secret_value(SecretId=secret_arn)
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
        body = base64.b64decode(body).decode("utf-8")

    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return {}


def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """Handle HTTP API invocations and return the realtime client token."""
    if event.get("requestContext", {}).get("http", {}).get("method") != "POST":
        return {
            "statusCode": 405,
            "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"},
            "body": json.dumps({"message": "Method Not Allowed"}),
        }

    body = _decode_body(event)
    instructions = body.get("instructions")
    voice = body.get("voice")
    expires_in = body.get("expires_in")

    api_base_url = os.environ.get("API_BASE_URL")
    bearer_secret_arn = os.environ["SECRET_NAME"]
    openai_secret_arn = os.environ["OPENAI_API_KEY_SECRET_ARN"]
    realtime_model = os.environ.get("REALTIME_MODEL", "gpt-4o-realtime-preview")

    try:
        bearer_token = _get_secret(bearer_secret_arn)
        openai_api_key = _get_secret(openai_secret_arn)
    except Exception:  # pragma: no cover - defensive guard in Lambda
        LOGGER.exception("Failed to load secrets")
        return {
            "statusCode": 500,
            "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"},
            "body": json.dumps({"message": "Failed to load secrets"}),
        }

    session_payload: Dict[str, Any] = {
        "modalities": ["audio", "text"],
        "tools": [
            {
                "type": "function",
                "name": "secure_ping",
                "description": "Echo numbers via the secure ping endpoint.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "number": {
                            "type": "string",
                            "description": "Optional value that will be echoed back",
                        }
                    },
                    "required": [],
                },
            }
        ],
    }

    if instructions:
        session_payload["instructions"] = instructions
    if voice:
        session_payload["voice"] = voice
    if expires_in:
        session_payload["expires_in"] = expires_in

    LOGGER.info("Requesting realtime session for model %s", realtime_model)

    request_url = OPENAI_RT_ENDPOINT_TEMPLATE.format(model=realtime_model)

    req = request.Request(
        request_url,
        data=json.dumps(session_payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {openai_api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with request.urlopen(req, timeout=DEFAULT_TIMEOUT_SECONDS) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except error.HTTPError as http_err:
        LOGGER.error("OpenAI realtime session request failed: %s", http_err.read())
        status = http_err.code if http_err.code else 502
        message = "Failed to create realtime session"
        return {
            "statusCode": status,
            "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"},
            "body": json.dumps({"message": message}),
        }
    except Exception:  # pragma: no cover - defensive guard in Lambda
        LOGGER.exception("Unexpected error during OpenAI realtime session request")
        return {
            "statusCode": 502,
            "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"},
            "body": json.dumps({"message": "Failed to create realtime session"}),
        }

    response_body = {
        "ok": True,
        "session": payload,
    }

    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"},
        "body": json.dumps(response_body),
    }
