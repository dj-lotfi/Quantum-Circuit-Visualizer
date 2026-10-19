"""Command-line entry point for the QViz web application."""
from __future__ import annotations

import argparse
import os

from .web import create_app


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the QViz circuit visualiser.")
    parser.add_argument("--host", default=os.environ.get("QVIZ_HOST", "127.0.0.1"))
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("PORT", "5000")),
    )
    args = parser.parse_args()

    print(f"Qiskit circuit visualiser: http://{args.host}:{args.port}/")
    create_app().run(
        host=args.host,
        port=args.port,
        debug=False,
        threaded=True,
    )


if __name__ == "__main__":
    main()
