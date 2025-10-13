"""Simple Lambda responder that returns a JSON ping payload."""

import json
import logging
from typing import Any, Dict

LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)


def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """Return a friendly ping response so the bearer authoriser can be exercised."""
    request_id = getattr(context, "aws_request_id", "")
    body = {
        "ok": True,
        "path": event.get("rawPath"),
        "requestId": request_id,
    }

    LOGGER.info(
        json.dumps(
            {
                "level": "info",
                "msg": "ping",
                "requestId": request_id,
            }
        )
    )

    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }
