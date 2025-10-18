"""Test helpers for realtime token module."""

import sys
from types import ModuleType


def _install_boto3_stub() -> None:
    """Ensure the boto3 namespace exists so tests can patch it."""
    try:
        __import__("boto3")
    except ModuleNotFoundError:
        stub = ModuleType("boto3")

        def _unavailable_client(*args, **kwargs):
            raise ModuleNotFoundError("boto3 is required to create AWS clients")

        stub.client = _unavailable_client  # type: ignore[attr-defined]
        sys.modules["boto3"] = stub


_install_boto3_stub()
