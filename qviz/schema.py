"""Gate 'schema' details: definition, matrix and a Qiskit drawing of a gate."""
from __future__ import annotations

import base64
import io

import numpy as np
from qiskit import QuantumCircuit
from qiskit.circuit.library import get_standard_gate_name_mapping
from qiskit.quantum_info import Operator


def _fmt_complex(c: complex) -> str:
    re, im = round(c.real, 3), round(c.imag, 3)
    if abs(im) < 1e-9:
        return f"{re:g}"
    if abs(re) < 1e-9:
        return f"{im:g}i"
    return f"{re:g}{'+' if im >= 0 else '-'}{abs(im):g}i"


def _png(circuit: QuantumCircuit) -> str | None:
    try:
        import matplotlib

        matplotlib.use("Agg")
        fig = circuit.draw(output="mpl", style="iqp", fold=-1)
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=110, bbox_inches="tight", transparent=False)
        import matplotlib.pyplot as plt

        plt.close(fig)
        return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception:
        return None


def gate_schema(name: str, params: list[float], num_qubits: int, backend=None, qubits: list[int] | None = None) -> dict:
    mapping = get_standard_gate_name_mapping()
    base = mapping.get(name)
    out: dict = {"name": name, "params": params, "num_qubits": num_qubits}
    if base is None:
        out["error"] = f"Unknown gate '{name}'"
        return out
    try:
        gate = base.__class__(*params) if params else base
    except Exception:
        gate = base
    cls = getattr(gate, "base_class", type(gate))
    doc = (cls.__doc__ or "").strip()
    out["doc"] = doc.split("\n\n")[0].strip() if doc else ""
    out["class"] = cls.__name__
    try:
        qc = QuantumCircuit(gate.num_qubits, gate.num_clbits)
        qc.append(gate, range(gate.num_qubits), range(gate.num_clbits))
        out["text"] = qc.draw(output="text", fold=-1).single_string()
        out["png"] = _png(qc)
    except Exception as exc:  # pragma: no cover
        out["text_error"] = str(exc)
    if name not in ("measure", "reset", "barrier", "delay"):
        try:
            mat = Operator(gate).data
            out["matrix"] = [[_fmt_complex(c) for c in row] for row in mat]
        except Exception:
            pass
        try:
            defn = gate.definition
            if defn is not None and len(defn.data) > 0:
                out["definition"] = defn.draw(output="text", fold=-1).single_string()
                out["definition_png"] = _png(defn)
        except Exception:
            pass
    if backend is not None and qubits:
        try:
            props = backend.target[name].get(tuple(qubits))
            if props is not None:
                out["hardware"] = {
                    "duration_ns": None if props.duration is None else round(props.duration * 1e9, 3),
                    "error": None if props.error is None else float(props.error),
                    "qubits": qubits,
                }
        except Exception:
            pass
    return out
