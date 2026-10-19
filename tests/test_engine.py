"""Regression checks for the compile pipeline.  Run: python tests/test_engine.py  (or pytest)."""
from __future__ import annotations

import os
import sys
import warnings

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
warnings.filterwarnings("ignore")

from qiskit_ibm_runtime.fake_provider import FakeGuadalupeV2, FakeSherbrooke, FakeTorino  # noqa: E402

from qviz.circuits import EXAMPLES, build_example, load_qasm  # noqa: E402
from qviz.engine import Compiler  # noqa: E402
from qviz.layout import qubit_coordinates  # noqa: E402


def _check_model(model, backend):
    target = backend.target
    gates = model["logical"]["gates"]
    origins = {r["origin"] for r in model["routed"]}
    assert all(g["id"] in origins for g in gates), "every logical gate must map to routed records"
    for op in model["ops"]:
        assert op["end"] >= op["start"]
        if len(op["qubits"]) == 2:
            assert tuple(op["qubits"]) in target[op["name"]], f"{op['name']} on {op['qubits']} not native"
    # ops are ordered by end time and respect per-qubit causality
    last_end = {}
    for op in model["ops"]:
        for q in op["qubits"]:
            assert op["start"] >= last_end.get(q, 0.0) - 1e-6
            last_end[q] = max(last_end.get(q, 0.0), op["end"])
    # each routed record is one contiguous block on its qubits
    for rec in model["routed"]:
        assert rec["end"] >= rec["start"]
    if model["sim"]["ok"]:
        frames = model["sim"]["frames"]
        assert len(frames) == len(model["ops"]) + 1
        assert all(len(f["bloch"]) == len(model["sim"]["active_qubits"]) for f in frames)


def test_examples_on_guadalupe():
    backend = FakeGuadalupeV2()
    for key in EXAMPLES:
        model = Compiler(backend, seed=5).compile(build_example(key))
        _check_model(model, backend)


def test_direction_and_labels_on_ecr_backend():
    backend = FakeSherbrooke()
    model = Compiler(backend, seed=11).compile(build_example("ghz_star", 12))
    _check_model(model, backend)
    assert model["stats"]["routing_swaps"] > 0


def test_too_large_to_simulate():
    backend = FakeSherbrooke()
    model = Compiler(backend, seed=11).compile(build_example("ghz_star", 20))
    assert not model["sim"]["ok"] and "limited" in model["sim"]["reason"]
    assert len(model["ops"]) > 0 and model["total_time"] > 0


def test_qasm_and_custom_gates():
    qasm = 'OPENQASM 2.0;\ninclude "qelib1.inc";\nqreg q[3]; creg c[3]; h q[0]; ccx q[0],q[1],q[2]; cswap q[0],q[1],q[2]; measure q -> c;'
    backend = FakeTorino()
    model = Compiler(backend, seed=1).compile(load_qasm(qasm))
    _check_model(model, backend)
    assert model["logical"]["gates"][1]["name"] == "ccx"


def test_layouts_fit_coupling_map():
    for B in (FakeGuadalupeV2, FakeSherbrooke, FakeTorino):
        b = B()
        coords, method = qubit_coordinates(b)
        assert len(coords) == b.num_qubits
        for a, c in b.coupling_map.get_edges():
            assert abs(coords[a][0] - coords[c][0]) + abs(coords[a][1] - coords[c][1]) <= 1.05, (B.__name__, method)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
