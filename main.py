"""Local dev entrypoint: `uv run main.py` starts the API + frontend.

For production, hosts run `uvicorn app.main:app` directly (see Dockerfile);
this file is just a convenience for running locally.
"""

import os

import uvicorn


def main():
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run("app.main:app", host="127.0.0.1", port=port, reload=True)


if __name__ == "__main__":
    main()
