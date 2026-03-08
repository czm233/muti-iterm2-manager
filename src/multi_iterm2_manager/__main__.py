from __future__ import annotations

import uvicorn

from multi_iterm2_manager.config import load_settings


def main() -> None:
    settings = load_settings()
    uvicorn.run(
        "multi_iterm2_manager.server:app",
        host=settings.host,
        port=settings.port,
        reload=False,
    )


if __name__ == "__main__":
    main()
