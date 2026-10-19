"""Web application used by the standalone server and notebook display helper."""
from __future__ import annotations

import inspect
import os
import traceback
from functools import lru_cache
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request, send_from_directory

from .circuits import build_example, example_list, load_qasm
from .engine import CompileError, Compiler
from .schema import gate_schema


@lru_cache(maxsize=1)
def backend_classes() -> dict[str, type]:
    import qiskit_ibm_runtime.fake_provider as fp

    out = {}
    for name in dir(fp):
        if not name.startswith("Fake") or "Provider" in name or name == "FakeFractionalBackend":
            continue
        cls = getattr(fp, name)
        if inspect.isclass(cls):
            out[name] = cls
    return out


@lru_cache(maxsize=8)
def get_backend(name: str):
    return backend_classes()[name]()


@lru_cache(maxsize=1)
def backend_catalog():
    items = []
    for name, cls in backend_classes().items():
        try:
            backend = cls()
            if backend.num_qubits < 2 or backend.coupling_map is None:
                continue
            basis = sorted(
                operation
                for operation in backend.target.operation_names
                if operation not in ("delay", "if_else", "for_loop", "switch_case", "while_loop")
            )
            items.append(
                {
                    "id": name,
                    "name": backend.name,
                    "num_qubits": backend.num_qubits,
                    "basis": basis,
                }
            )
        except Exception:
            continue
    items.sort(key=lambda item: (item["num_qubits"], item["name"]))
    return items


def create_app(*, preset_model: dict[str, Any] | None = None) -> Flask:
    static_folder = Path(__file__).with_name("static")
    app = Flask(__name__, static_folder=str(static_folder), static_url_path="/static")
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
    app.config["QVIZ_PRESET_MODEL"] = preset_model

    @app.get("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    @app.get("/api/backends")
    def api_backends():
        return jsonify(backend_catalog())

    @app.get("/api/examples")
    def api_examples():
        return jsonify(example_list())

    @app.post("/api/compile")
    def api_compile():
        preset = app.config.get("QVIZ_PRESET_MODEL")
        body = request.get_json(force=True) or {}
        if preset is not None and body.get("initial"):
            return jsonify(preset)
        try:
            backend = get_backend(body.get("backend", "FakeManilaV2"))
            circuit = body.get("circuit", {})
            if circuit.get("kind") == "qasm":
                quantum_circuit = load_qasm(circuit.get("text", ""))
            else:
                quantum_circuit = build_example(circuit.get("id", "ghz"), circuit.get("n"))
            model = Compiler(
                backend,
                seed=int(body.get("seed", 11)),
                layout_method=body.get("layout_method", "sabre"),
                routing_method=body.get("routing_method", "sabre"),
            ).compile(quantum_circuit, sim_seed=int(body.get("sim_seed", 1234)))
            return jsonify(model)
        except CompileError as exc:
            return jsonify({"error": str(exc)}), 400
        except Exception as exc:  # pragma: no cover
            traceback.print_exc()
            return jsonify({"error": f"{type(exc).__name__}: {exc}"}), 500

    @app.post("/api/gate")
    def api_gate():
        body = request.get_json(force=True) or {}
        backend = get_backend(body["backend"]) if body.get("backend") in backend_classes() else None
        try:
            return jsonify(
                gate_schema(
                    body["name"],
                    body.get("params", []),
                    int(body.get("num_qubits", 1)),
                    backend,
                    body.get("qubits"),
                )
            )
        except Exception as exc:  # pragma: no cover
            traceback.print_exc()
            return jsonify({"error": str(exc)}), 500

    return app
