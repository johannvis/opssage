# Unit Tests Overview

This repository currently ships a Python test suite that exercises the
`realtime_token` Lambda entry point living under `gpt-actions-aws/lib/src`.
The tests run automatically in CI and can also be executed locally.

## Python (pytest)

- **Location:** `gpt-actions-aws/lib/src/tests/test_realtime_token.py`
- **Command:** `pytest gpt-actions-aws/lib/src/tests`
- **What it covers:** request validation, CORS handling, model selection,
  secret retrieval, logging, retry logic, and error paths when calling OpenAI.

### Notes for local runs

1. Activate a virtual environment with Python 3.11+ and install the dev
   dependencies (for example, `pip install -r requirements-dev.txt` if you
   have the file, otherwise install `pytest` manually).
2. No AWS setup is required—the tests stub the `boto3` client automatically.
3. From the repo root, execute the command shown above.

CI runs the same command as part of the workflow so the tests listed here are
what you can expect on every pull request. Additional test suites (for
example, frontend Jest tests) will be added to this document as they come
online.
