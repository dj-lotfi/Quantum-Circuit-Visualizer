"""Built-in example circuits and QASM loading."""
from __future__ import annotations

import math

import numpy as np
from qiskit import QuantumCircuit, qasm2, qasm3
from qiskit.circuit.library import QFT
from qiskit.circuit.random import random_circuit


def ghz(n: int = 4) -> QuantumCircuit:
    qc = QuantumCircuit(n, n, name=f"GHZ-{n}")
    qc.h(0)
    for i in range(n - 1):
        qc.cx(i, i + 1)
    qc.measure(range(n), range(n))
    return qc


def ghz_star(n: int = 5) -> QuantumCircuit:
    """GHZ with every CX controlled from qubit 0 (forces routing swaps)."""
    qc = QuantumCircuit(n, n, name=f"GHZ-star-{n}")
    qc.h(0)
    for i in range(1, n):
        qc.cx(0, i)
    qc.measure(range(n), range(n))
    return qc


def qft(n: int = 4) -> QuantumCircuit:
    qc = QuantumCircuit(n, n, name=f"QFT-{n}")
    qc.x(0)
    if n > 1:
        qc.h(n - 1)
    qc.compose(QFT(n, do_swaps=True).decompose(), inplace=True)
    qc.measure(range(n), range(n))
    return qc


def bernstein_vazirani(n: int = 4, secret: str | None = None) -> QuantumCircuit:
    secret = secret or "".join("1" if i % 2 == 0 else "0" for i in range(n))
    secret = secret[:n].rjust(n, "0")
    qc = QuantumCircuit(n + 1, n, name=f"Bernstein-Vazirani-{n}")
    qc.x(n)
    qc.h(range(n + 1))
    qc.barrier()
    for i, bit in enumerate(reversed(secret)):
        if bit == "1":
            qc.cx(i, n)
    qc.barrier()
    qc.h(range(n))
    qc.measure(range(n), range(n))
    return qc


def grover(n: int = 3) -> QuantumCircuit:
    """Grover search marking |11..1> with a multi-controlled Z, one iteration."""
    qc = QuantumCircuit(n, n, name=f"Grover-{n}")
    qc.h(range(n))
    iterations = max(1, int(round(math.pi / 4 * math.sqrt(2**n))))
    for _ in range(iterations):
        # oracle: phase flip on |1...1>
        qc.h(n - 1)
        qc.mcx(list(range(n - 1)), n - 1)
        qc.h(n - 1)
        # diffuser
        qc.h(range(n))
        qc.x(range(n))
        qc.h(n - 1)
        qc.mcx(list(range(n - 1)), n - 1)
        qc.h(n - 1)
        qc.x(range(n))
        qc.h(range(n))
    qc.measure(range(n), range(n))
    return qc


def teleportation(n: int = 3) -> QuantumCircuit:
    qc = QuantumCircuit(3, 3, name="Teleportation")
    qc.ry(0.8, 0)
    qc.rz(0.4, 0)
    qc.h(1)
    qc.cx(1, 2)
    qc.cx(0, 1)
    qc.h(0)
    qc.measure(0, 0)
    qc.measure(1, 1)
    # deferred (coherent) corrections so the circuit stays unitary-simulable
    qc.cx(1, 2)
    qc.cz(0, 2)
    qc.measure(2, 2)
    return qc


def toffoli_chain(n: int = 4) -> QuantumCircuit:
    qc = QuantumCircuit(n, n, name=f"Toffoli-chain-{n}")
    qc.x(0)
    qc.x(1)
    for i in range(n - 2):
        qc.ccx(i, i + 1, i + 2)
    qc.measure(range(n), range(n))
    return qc


def random_demo(n: int = 5, depth: int = 6, seed: int = 3) -> QuantumCircuit:
    qc = random_circuit(n, depth, max_operands=2, measure=True, seed=seed)
    qc.name = f"Random-{n}x{depth}"
    return qc


def swap_test(n: int = 3) -> QuantumCircuit:
    qc = QuantumCircuit(3, 1, name="Swap-test")
    qc.ry(1.1, 1)
    qc.ry(0.3, 2)
    qc.h(0)
    qc.cswap(0, 1, 2)
    qc.h(0)
    qc.measure(0, 0)
    return qc


EXAMPLES = {
    "ghz": {"title": "GHZ (linear chain)", "fn": ghz, "min": 2, "max": 24, "default": 4,
            "desc": "H then a chain of CX gates; a neighbour-friendly entangling circuit."},
    "ghz_star": {"title": "GHZ (star, needs swaps)", "fn": ghz_star, "min": 3, "max": 24, "default": 5,
                 "desc": "All CX controlled from qubit 0, so the router must insert SWAPs."},
    "qft": {"title": "Quantum Fourier Transform", "fn": qft, "min": 2, "max": 8, "default": 4,
            "desc": "QFT on |0...01> with controlled-phase gates and final swaps."},
    "bv": {"title": "Bernstein-Vazirani", "fn": bernstein_vazirani, "min": 2, "max": 20, "default": 4,
           "desc": "Finds a hidden bit-string with one oracle query."},
    "grover": {"title": "Grover search", "fn": grover, "min": 2, "max": 5, "default": 3,
               "desc": "Amplifies |11..1>; the multi-controlled gates expand into many 2-qubit gates."},
    "teleport": {"title": "Teleportation", "fn": teleportation, "min": 3, "max": 3, "default": 3,
                 "desc": "Teleports a state from qubit 0 to qubit 2 (deferred corrections)."},
    "toffoli": {"title": "Toffoli chain", "fn": toffoli_chain, "min": 3, "max": 8, "default": 4,
                "desc": "3-qubit gates decomposed by the compiler into 1- and 2-qubit gates."},
    "swaptest": {"title": "Swap test", "fn": swap_test, "min": 3, "max": 3, "default": 3,
                 "desc": "Controlled-SWAP between two prepared states."},
    "random": {"title": "Random circuit", "fn": random_demo, "min": 2, "max": 12, "default": 5,
               "desc": "qiskit.circuit.random.random_circuit with measurements."},
}


def example_list():
    return [
        {"id": k, "title": v["title"], "min": v["min"], "max": v["max"], "default": v["default"], "desc": v["desc"]}
        for k, v in EXAMPLES.items()
    ]


def build_example(example_id: str, n: int | None = None) -> QuantumCircuit:
    spec = EXAMPLES[example_id]
    n = spec["default"] if n is None else int(np.clip(n, spec["min"], spec["max"]))
    return spec["fn"](n)


def load_qasm(text: str) -> QuantumCircuit:
    text = text.strip()
    if text.startswith("OPENQASM 3"):
        qc = qasm3.loads(text)
    else:
        qc = qasm2.loads(text, custom_instructions=qasm2.LEGACY_CUSTOM_INSTRUCTIONS)
    if not qc.name or qc.name.startswith("circuit-"):
        qc.name = "QASM circuit"
    return qc
