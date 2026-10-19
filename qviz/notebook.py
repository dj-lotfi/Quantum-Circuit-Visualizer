"""Jupyter integration for QViz."""
from __future__ import annotations

import socket
import threading
from functools import partial

from IPython.display import IFrame

from . import compile_circuit
from .web import create_app


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _serve(app, *, height: int, width: str, query: str = ""):
    port = _free_port()
    thread = threading.Thread(
        target=partial(app.run, host="127.0.0.1", port=port, debug=False, threaded=True, use_reloader=False),
        daemon=True,
    )
    thread.start()
    return IFrame(src=f"http://127.0.0.1:{port}/{query}", width=width, height=height)


def display_circuit(circuit, backend, *, height: int = 900, width: str = "100%", **kwargs):
    """Display a fixed circuit/backend pair; notebook controls cannot replace either input."""
    model = compile_circuit(circuit, backend, **kwargs)
    return _serve(create_app(preset_model=model), height=height, width=width, query="?readonly=1")


def interactive_display(*, height: int = 900, width: str = "100%"):
    """Display the standalone interactive workspace with no circuit/backend arguments."""
    return _serve(create_app(), height=height, width=width)
