"""Lambda authoriser that validates bearer tokens using Australian English terminology."""

import json
import logging
import os
from typing import Any, Dict, Optional

import boto3
from botocore.exceptions import BotoCoreError, ClientError

LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)

_SECRET_CACHE: Optional[str] = None
_SECRET_VERSION: Optional[str] = None
_SECRET_NAME = os.environ.get("SECRET_NAME")
_SECRETS_CLIENT = boto3.client("secretsmanager")


def _load_secret(force_refresh: bool = False) -> str:
    """Fetch the current bearer token, refreshing the cache when we rotate the secret."""
    global _SECRET_CACHE, _SECRET_VERSION
    if _SECRET_CACHE is not None and not force_refresh:
        return _SECRET_CACHE

    if not _SECRET_NAME:
        raise RuntimeError("SECRET_NAME environment variable is not set")

    try:
        response = _SECRETS_CLIENT.get_secret_value(SecretId=_SECRET_NAME)
    except (BotoCoreError, ClientError) as exc:  # pragma: no cover - defensive runtime guard
        LOGGER.error("%s", exc)
        raise

    secret = response.get("SecretString", "")
    _SECRET_CACHE = secret.strip()
    _SECRET_VERSION = response.get("VersionId")
    return _SECRET_CACHE


def _ensure_latest_secret() -> None:
    """Ensure the cached secret matches the latest AWS Secrets Manager version."""
    if _SECRET_CACHE is None:
        _load_secret(force_refresh=True)
        return

    try:
        metadata = _SECRETS_CLIENT.describe_secret(SecretId=_SECRET_NAME) if _SECRET_NAME else None
    except (BotoCoreError, ClientError) as exc:  # pragma: no cover - defensive runtime guard
        LOGGER.error("%s", exc)
        raise

    if not metadata:
        return

    version_ids = metadata.get("VersionIdsToStages", {})
    current_version = next(
        (vid for vid, stages in version_ids.items() if "AWSCURRENT" in stages),
        None,
    )

    if current_version and current_version != _SECRET_VERSION:
        _load_secret(force_refresh=True)


def _extract_bearer(headers: Dict[str, Any]) -> Optional[str]:
    """Isolate the Bearer token from the request headers."""
    for key, value in headers.items():
        if key.lower() == "authorization" and isinstance(value, str):
            scheme, _, token = value.partition(" ")
            if scheme.lower() == "bearer":
                token = token.strip()
                return token if token else None
    return None


def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """Authorise the incoming request by comparing the supplied token with the secret value."""
    headers = event.get("headers") or {}
    token = _extract_bearer(headers)
    request_id = (
        event.get("requestContext", {}).get("requestId")
        or getattr(context, "aws_request_id", "")
    )

    is_authorised = False
    if token is not None:
        _ensure_latest_secret()
        secret_value = _load_secret()
        is_authorised = bool(secret_value) and token == secret_value

    if is_authorised:
        LOGGER.info(
            json.dumps(
                {
                    "level": "info",
                    "msg": "authorised",
                    "requestId": request_id,
                }
            )
        )

    return {
        "isAuthorized": is_authorised,
        "context": {
            "principalId": "prototypeBearer",
            "requestId": request_id,
        },
    }
