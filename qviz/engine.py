"""Compile a logical circuit onto a fake backend and produce a visualisation model.

Pipeline
--------
1. *Flatten* the logical circuit: every instruction becomes a logical gate
   record and is expanded into 1- and 2-qubit standard gates, each labelled with
   the id of the logical gate it came from.
2. *Route* with Qiskit (layout + SABRE routing only, no basis translation, no
   optimisation) so labels survive.  Swaps inserted by the router carry no label
   and are reported as routing swaps that move logical qubits around.
3. *Translate* each routed gate into the backend's native basis (cached per
   gate kind) and *schedule* it ASAP using the durations stored in the
   backend's ``Target``.
4. *Simulate* the native schedule with a ``Statevector`` restricted to the
   physical qubits that are actually used, recording a Bloch vector per qubit
   after every native operation.
"""
from __future__ import annotations

import copy
import time
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from qiskit import QuantumCircuit, transpile
from qiskit.circuit import ControlFlowOp, Instruction, Parameter, ParameterExpression
from qiskit.circuit.library import XGate, get_standard_gate_name_mapping
from qiskit.quantum_info import Operator, Statevector
from qiskit.transpiler import CouplingMap

from .layout import qubit_coordinates

STANDARD_GATES = set(get_standard_gate_name_mapping().keys()) - {"delay", "global_phase"}
NON_GATES = {"measure", "reset", "barrier", "delay"}
SIM_QUBIT_LIMIT = 16  # statevector simulation is refused above this many *active* physical qubits

# Fallback durations (seconds) when the target carries none.
DEFAULT_DURATIONS = {1: 35e-9, 2: 300e-9, "measure": 1000e-9, "reset": 1000e-9}


class CompileError(Exception):
    pass


@dataclass
class LogicalGate:
    id: int
    name: str
    params: list[float]
    qubits: list[int]
    clbits: list[int]
    label: str | None = None
    column: int = 0


@dataclass
class NativeOp:
    id: int
    name: str
    params: list[float]
    qubits: list[int]
    clbits: list[int]
    origin: int | None  # logical gate id, None for routing swaps
    kind: str  # gate | swap | routing_swap | measure | reset
    routed_id: int  # index of the routed (logical-level) instruction this came from
    start: float = 0.0
    duration: float = 0.0
    instruction: Instruction | None = field(default=None, repr=False)


def _params_to_float(op) -> list[float]:
    out = []
    for p in op.params:
        if isinstance(p, (Parameter, ParameterExpression)):
            if len(p.parameters) > 0:
                raise CompileError(
                    f"Gate '{op.name}' has unbound parameter(s) {sorted(str(x) for x in p.parameters)}; "
                    "bind all parameters before visualising."
                )
            p = float(p)
        if isinstance(p, (int, float, np.integer, np.floating)):
            out.append(float(p))
        elif isinstance(p, complex):
            out.append(float(p.real))
        else:
            out.append(0.0)
    return out


def _mutable(op):
    return op.to_mutable() if hasattr(op, "to_mutable") else op.copy()


def _expand(op, qubits, clbits, label, out: QuantumCircuit):
    """Append ``op`` to ``out`` as labelled standard 1q/2q gates (recursive)."""
    if isinstance(op, ControlFlowOp):
        raise CompileError(f"Control-flow operation '{op.name}' is not supported.")
    if op.name in ("barrier", "delay"):
        return
    if op.name in NON_GATES or (op.name in STANDARD_GATES and op.num_qubits <= 2):
        m = _mutable(op)
        m.label = label
        out.append(m, qubits, clbits)
        return
    definition = op.definition
    if definition is None:
        # e.g. UnitaryGate: synthesise into u/cx then expand.
        small = QuantumCircuit(op.num_qubits)
        small.append(op, range(op.num_qubits))
        definition = transpile(small, basis_gates=["u", "cx"], optimization_level=0)
    for ci in definition.data:
        qs = [qubits[definition.find_bit(q).index] for q in ci.qubits]
        cs = [clbits[definition.find_bit(c).index] for c in ci.clbits]
        _expand(ci.operation, qs, cs, label, out)


def _assign_columns(gates: list[LogicalGate], num_qubits: int):
    """Greedy left-to-right layering for drawing the logical circuit."""
    cursor = [0] * (num_qubits + 1)  # last slot is the classical wire
    for g in gates:
        if not g.qubits:
            continue
        lo, hi = min(g.qubits), max(g.qubits)
        span = list(range(lo, hi + 1))
        if g.clbits:
            span = list(range(lo, num_qubits + 1))
        col = max(cursor[i] for i in span)
        g.column = col
        for i in span:
            cursor[i] = col + 1


def _translation_basis(target) -> list[str]:
    return sorted({n for n in target.operation_names if n in STANDARD_GATES})


class Compiler:
    def __init__(self, backend, *, seed: int = 11, layout_method: str = "sabre", routing_method: str = "sabre"):
        self.backend = backend
        self.target = backend.target
        self.seed = seed
        self.layout_method = layout_method
        self.routing_method = routing_method
        self._translation_cache: dict[tuple, list[tuple[str, list[float], list[int]]]] = {}
        self.basis = _translation_basis(self.target)
        if not any(n in self.basis for n in ("cx", "cz", "ecr", "iswap", "rzz", "cp")):
            raise CompileError(f"Backend {backend.name} has no 2-qubit gate in its basis.")

    # ------------------------------------------------------------------ flatten
    def flatten(self, circuit: QuantumCircuit) -> tuple[list[LogicalGate], QuantumCircuit]:
        gates: list[LogicalGate] = []
        labelled = QuantumCircuit(circuit.num_qubits, circuit.num_clbits)
        for ci in circuit.data:
            op = ci.operation
            if op.name == "barrier":
                continue
            gid = len(gates)
            qubits = [circuit.find_bit(q).index for q in ci.qubits]
            clbits = [circuit.find_bit(c).index for c in ci.clbits]
            gates.append(LogicalGate(gid, op.name, _params_to_float(op), qubits, clbits, getattr(op, "label", None)))
            _expand(op, [labelled.qubits[i] for i in qubits], [labelled.clbits[i] for i in clbits], f"g{gid}", labelled)
        _assign_columns(gates, circuit.num_qubits)
        return gates, labelled

    # -------------------------------------------------------------------- route
    def route(self, labelled: QuantumCircuit):
        names = sorted({ci.operation.name for ci in labelled.data} - NON_GATES | {"swap"})
        if labelled.num_qubits > self.backend.num_qubits:
            raise CompileError(
                f"Circuit uses {labelled.num_qubits} qubits but {self.backend.name} only has {self.backend.num_qubits}."
            )
        # Route on the *symmetric* coupling map: gate direction is fixed later, per native
        # gate, so the router does not wrap labelled gates in unlabelled H sandwiches.
        cmap = copy.deepcopy(self.backend.coupling_map)
        cmap.make_symmetric()
        return transpile(
            labelled,
            coupling_map=cmap,
            basis_gates=names,
            optimization_level=0,
            layout_method=self.layout_method,
            routing_method=self.routing_method,
            seed_transpiler=self.seed,
        )

    # ---------------------------------------------------------------- translate
    def _direction(self, phys: list[int]) -> tuple[bool, bool]:
        """Which orientations of a 2-qubit native gate exist on this physical pair."""
        fwd = bwd = False
        for name in self.basis:
            try:
                props = self.target[name]
            except Exception:
                continue
            if (phys[0], phys[1]) in props:
                fwd = True
            if (phys[1], phys[0]) in props:
                bwd = True
        return fwd, bwd

    def translate(self, op, phys: list[int]) -> list[tuple[str, list[float], list[int]]]:
        """Native decomposition of ``op`` as (name, params, local qubit indices)."""
        fwd, bwd = self._direction(phys) if op.num_qubits == 2 else (True, True)
        key = (op.name, tuple(round(p, 12) for p in _params_to_float(op)), op.num_qubits, fwd, bwd)
        if key in self._translation_cache:
            return self._translation_cache[key]
        native_here = op.name in self.basis and (op.num_qubits < 2 or fwd or not bwd)
        if native_here or op.name in NON_GATES:
            res = [(op.name, _params_to_float(op), list(range(op.num_qubits)))]
        else:
            small = QuantumCircuit(op.num_qubits)
            small.append(op, range(op.num_qubits))
            kwargs = {}
            if op.num_qubits == 2 and (fwd or bwd):
                edges = ([[0, 1]] if fwd else []) + ([[1, 0]] if bwd else [])
                kwargs = {"coupling_map": CouplingMap(edges), "initial_layout": [0, 1]}
            tr = transpile(small, basis_gates=self.basis, optimization_level=0, **kwargs)
            res = [
                (ci.operation.name, _params_to_float(ci.operation), [tr.find_bit(q).index for q in ci.qubits])
                for ci in tr.data
                if ci.operation.name != "barrier"
            ]
        self._translation_cache[key] = res
        return res

    def duration(self, name: str, qubits: list[int]) -> float:
        try:
            props = self.target[name].get(tuple(qubits))
            if props is not None and props.duration is not None:
                return float(props.duration)
        except Exception:
            pass
        if name in ("measure", "reset"):
            return DEFAULT_DURATIONS[name]
        return DEFAULT_DURATIONS.get(len(qubits), DEFAULT_DURATIONS[2])

    # ------------------------------------------------------------------ compile
    def compile(self, circuit: QuantumCircuit, *, simulate: bool = True, sim_seed: int = 1234) -> dict[str, Any]:
        t_start = time.perf_counter()
        gates, labelled = self.flatten(circuit)
        routed = self.route(labelled)
        n_phys = self.backend.num_qubits

        vl = routed.layout.initial_virtual_layout(filter_ancillas=True).get_virtual_bits()
        initial_layout = {}
        for q, p in vl.items():
            idx = labelled.find_bit(q).index
            if idx < circuit.num_qubits:
                initial_layout[str(idx)] = p

        # ---- build native ops from the routed circuit
        native: list[NativeOp] = []
        routed_records = []
        gate_mapping = get_standard_gate_name_mapping()
        for ci in routed.data:
            op = ci.operation
            if op.name == "barrier":
                continue
            rid = len(routed_records)
            phys = [routed.find_bit(q).index for q in ci.qubits]
            cl = [routed.find_bit(c).index for c in ci.clbits]
            label = getattr(op, "label", None)
            origin = int(label[1:]) if label and label.startswith("g") and label[1:].isdigit() else None
            if op.name == "swap" and origin is None:
                kind = "routing_swap"
            elif op.name == "swap":
                kind = "swap"
            elif op.name in ("measure", "reset"):
                kind = op.name
            else:
                kind = "gate"
            routed_records.append(
                {"id": rid, "name": op.name, "params": _params_to_float(op), "qubits": phys, "clbits": cl,
                 "origin": origin, "kind": kind, "ops": []}
            )
            for name, params, local in self.translate(op, phys):
                q = [phys[i] for i in local]
                inst = None
                if name not in NON_GATES:
                    base = gate_mapping.get(name)
                    inst = base.__class__(*params) if params else _mutable(base)
                nop = NativeOp(len(native), name, params, q, cl if name in ("measure", "reset") else [], origin, kind,
                               rid, instruction=inst)
                nop.duration = self.duration(name, q)
                native.append(nop)
                routed_records[-1]["ops"].append(nop.id)

        # ---- ASAP schedule (seconds -> ns).  Each routed instruction is scheduled as one
        # contiguous block (its native ops may not start before every qubit it touches is
        # free), so a logical gate occupies a single interval on the backend.
        cursor = [0.0] * n_phys
        ccursor = [0.0] * max(1, routed.num_clbits)
        for rec in routed_records:
            block = max([cursor[q] for q in rec["qubits"]] + [ccursor[c] for c in rec["clbits"]])
            for oid in rec["ops"]:
                nop = native[oid]
                st = max([block] + [cursor[q] for q in nop.qubits] + [ccursor[c] for c in nop.clbits])
                nop.start = st
                end = st + nop.duration
                for q in nop.qubits:
                    cursor[q] = end
                for c in nop.clbits:
                    ccursor[c] = end
        total = max(cursor) if native else 0.0
        # Order by end time: respects data dependencies and makes "ops finished by time t" a prefix.
        order = sorted(range(len(native)), key=lambda i: (native[i].start + native[i].duration, native[i].start, i))
        native = [native[i] for i in order]
        remap = {nop.id: k for k, nop in enumerate(native)}
        for nop in native:
            nop.id = remap[nop.id]
        for rec in routed_records:
            rec["ops"] = sorted(remap[o] for o in rec["ops"])
            ops = [native[o] for o in rec["ops"]]
            rec["start"] = round(min(o.start for o in ops) * 1e9, 4)
            rec["end"] = round(max(o.start + o.duration for o in ops) * 1e9, 4)

        # ---- logical qubit position tracking (routing swaps only)
        swaps = [
            {"routed_id": rec["id"], "t": rec["end"], "qubits": rec["qubits"]}
            for rec in routed_records
            if rec["kind"] == "routing_swap"
        ]

        # ---- simulation
        active = sorted({q for nop in native for q in nop.qubits})
        sim: dict[str, Any] = {"ok": False, "active_qubits": active, "limit": SIM_QUBIT_LIMIT}
        if not simulate:
            sim["reason"] = "Simulation disabled."
        elif len(active) > SIM_QUBIT_LIMIT:
            sim["reason"] = (
                f"The routed circuit touches {len(active)} physical qubits; statevector simulation is limited to "
                f"{SIM_QUBIT_LIMIT} qubits. Qubit values will not be shown."
            )
        else:
            sim.update(self._simulate(native, active, routed.num_clbits, sim_seed))
            sim["ok"] = True

        coords, method = qubit_coordinates(self.backend)
        edges = sorted({(min(a, b), max(a, b)) for a, b in self.backend.coupling_map.get_edges()})
        gate_errors = {}
        for name in self.basis:
            try:
                for qs, props in self.target[name].items():
                    if props is not None and props.error is not None:
                        gate_errors[f"{name}:{','.join(map(str, qs))}"] = round(float(props.error), 6)
            except Exception:
                pass

        final = routed.layout.final_index_layout(filter_ancillas=True)
        qubit_props = []
        for i in range(n_phys):
            try:
                qp = self.backend.qubit_properties(i)
                qubit_props.append({"t1_us": None if qp.t1 is None else round(qp.t1 * 1e6, 2),
                                    "t2_us": None if qp.t2 is None else round(qp.t2 * 1e6, 2),
                                    "freq_ghz": None if qp.frequency is None else round(qp.frequency / 1e9, 4)})
            except Exception:
                qubit_props.append({})
        readout_err = {}
        try:
            for qs, props in self.target["measure"].items():
                if props is not None and props.error is not None:
                    readout_err[str(qs[0])] = round(float(props.error), 5)
        except Exception:
            pass
        return {
            "backend": {
                "name": self.backend.name, "num_qubits": n_phys, "coords": coords, "layout_method": method,
                "edges": [list(e) for e in edges], "basis": self.basis, "dt": self.target.dt,
                "errors": gate_errors, "qubit_props": qubit_props, "readout_errors": readout_err,
            },
            "logical": {
                "num_qubits": circuit.num_qubits, "num_clbits": circuit.num_clbits, "name": circuit.name,
                "gates": [g.__dict__ for g in gates],
                "columns": max((g.column for g in gates), default=-1) + 1,
            },
            "layout": {"initial": initial_layout, "swaps": swaps,
                       "final": {str(k): int(v) for k, v in enumerate(final)}},
            "routed": routed_records,
            "ops": [
                {"id": nop.id, "name": nop.name, "params": nop.params, "qubits": nop.qubits, "clbits": nop.clbits,
                 "origin": nop.origin, "kind": nop.kind, "routed_id": nop.routed_id,
                 "start": round(nop.start * 1e9, 4), "end": round((nop.start + nop.duration) * 1e9, 4),
                 "duration": round(nop.duration * 1e9, 4)}
                for nop in native
            ],
            "total_time": round(total * 1e9, 4),
            "sim": sim,
            "stats": {
                "compile_seconds": round(time.perf_counter() - t_start, 3),
                "logical_gates": len(gates), "routed_instructions": len(routed_records),
                "native_ops": len(native), "routing_swaps": len(swaps), "depth": circuit.depth(),
            },
        }

    # ----------------------------------------------------------------- simulate
    def _simulate(self, native: list[NativeOp], active: list[int], num_clbits: int, seed: int) -> dict[str, Any]:
        n = len(active)
        local = {q: i for i, q in enumerate(active)}
        rng = np.random.default_rng(seed)
        sv = Statevector.from_int(0, 2**n)
        cbits: list[int | None] = [None] * max(num_clbits, 0)
        measured: dict[int, int] = {}  # physical qubit -> last measured value (cleared when touched again)
        frames: list[dict[str, Any]] = []

        def bloch_all(state: Statevector):
            psi = np.asarray(state.data).reshape([2] * n)
            out = []
            for q in range(n):
                m = np.moveaxis(psi, n - 1 - q, 0).reshape(2, -1)
                rho = m @ m.conj().T
                out.append([round(float(2 * rho[0, 1].real), 4), round(float(2 * rho[1, 0].imag), 4),
                            round(float((rho[0, 0] - rho[1, 1]).real), 4)])
            return out

        def collapse(state: Statevector, q: int) -> tuple[Statevector, int]:
            probs = state.probabilities([q])
            outcome = int(rng.random() < probs[1])
            proj = np.zeros((2, 2))
            proj[outcome, outcome] = 1.0
            new = state.evolve(Operator(proj), qargs=[q])
            norm = np.linalg.norm(new.data)
            return (Statevector(new.data / norm) if norm > 0 else state), outcome

        def snapshot():
            return {"bloch": bloch_all(sv), "measured": {str(q): v for q, v in measured.items()}, "cbits": list(cbits)}

        frames.append(snapshot())
        for nop in native:
            lq = [local[q] for q in nop.qubits]
            if nop.name == "measure":
                for i, q in enumerate(lq):
                    sv, outcome = collapse(sv, q)
                    measured[nop.qubits[i]] = outcome
                    if i < len(nop.clbits) and nop.clbits[i] < len(cbits):
                        cbits[nop.clbits[i]] = outcome
            elif nop.name == "reset":
                for i, q in enumerate(lq):
                    sv, outcome = collapse(sv, q)
                    if outcome == 1:
                        sv = sv.evolve(XGate(), qargs=[q])
                    measured.pop(nop.qubits[i], None)
            else:
                for q in nop.qubits:
                    measured.pop(q, None)
                sv = sv.evolve(nop.instruction, qargs=lq)
            frames.append(snapshot())
        return {"frames": frames, "num_frames": len(frames)}
