"""Simple Lambda responder that returns a JSON ping payload."""

import base64
import json
import logging
from typing import Any, Dict, Optional

LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)


def _extract_number(event: Dict[str, Any]) -> Optional[str]:
    """Try to resolve the `number` attribute from query parameters or a JSON body."""
    query_params = event.get("queryStringParameters") or {}
    number = query_params.get("number")
    if number:
        return str(number)

    raw_body = event.get("body")
    if not raw_body:
        return None

    if event.get("isBase64Encoded"):
        try:
            raw_body = base64.b64decode(raw_body).decode("utf-8")
        except Exception:
            return None

    try:
        parsed_body = json.loads(raw_body)
    except (TypeError, ValueError):
        return None

    if isinstance(parsed_body, dict) and "number" in parsed_body:
        value = parsed_body.get("number")
        if value is None:
            return None
        return str(value)

    return None


def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """Return a friendly ping response so the bearer authoriser can be exercised."""
    request_id = getattr(context, "aws_request_id", "")
    number = _extract_number(event)
    message = f"you sent me {number}" if number else "you sent me nothing"

    body = {
        "ok": True,
        "path": event.get("rawPath"),
        "requestId": request_id,
        "message": message,
    }

    LOGGER.info(
        json.dumps(
            {
                "level": "info",
                "msg": "ping",
                "requestId": request_id,
                "number": number,
            }
        )
    )

    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }
