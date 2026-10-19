"""Physical qubit coordinates for a backend.

Uses the hard-coded coordinate tables that ship with
``qiskit.visualization.gate_map.plot_gate_map`` when the backend size is known,
and otherwise derives a heavy-hex layout from the coupling graph (rows of
consecutive indices joined by single "bridge" qubits), falling back to a
spring layout for arbitrary graphs.
"""
from __future__ import annotations

import inspect
import re
from functools import lru_cache

import rustworkx as rx


@lru_cache(maxsize=1)
def _qiskit_coordinate_tables() -> dict[int, list[list[int]]]:
    """Extract the ``qubit_coordinates_map`` literal from qiskit's source."""
    try:
        from qiskit.visualization import gate_map

        src = inspect.getsource(gate_map.plot_gate_map)
    except Exception:  # pragma: no cover - defensive
        return {}
    lines = src.splitlines()
    try:
        start = next(i for i, l in enumerate(lines) if "qubit_coordinates_map = {}" in l)
    except StopIteration:
        return {}
    body = []
    for line in lines[start:]:
        if "qubit_coordinates_map" not in line and re.match(r"\s*\w+ = ", line):
            break
        body.append(line)
    code = inspect.cleandoc("\n".join(body))
    ns: dict = {}
    try:
        exec(code, {}, ns)  # noqa: S102 - trusted qiskit source
    except Exception:  # pragma: no cover
        return {}
    return ns.get("qubit_coordinates_map", {})


def _heavy_hex_from_graph(num_qubits: int, edges: set[tuple[int, int]]):
    """Derive positions assuming IBM's row-major numbering.

    Maximal runs of consecutive, coupled indices form rows; leftover single
    qubits are "bridges" between rows (heavy-hex).  Rows that couple directly
    (square lattices, T shapes) are stacked one unit apart, rows joined through
    bridges two units apart, and each row is shifted so its links line up with
    the row above.
    """
    runs: list[list[int]] = []
    for i in range(num_qubits):
        if runs and (i - 1, i) in edges:
            runs[-1].append(i)
        else:
            runs.append([i])
    rows = [r for r in runs if len(r) >= 2]
    if not rows or sum(len(r) for r in rows) < 0.6 * num_qubits:
        return None
    nbrs: dict[int, set[int]] = {i: set() for i in range(num_qubits)}
    for a, b in edges:
        nbrs[a].add(b)
        nbrs[b].add(a)
    row_of: dict[int, int] = {q: ri for ri, r in enumerate(rows) for q in r}
    pos: dict[int, tuple[float, float]] = {}
    y = 0.0
    offset = 0.0
    for ri, r in enumerate(rows):
        if ri > 0:
            shifts, via_bridge = [], False
            for ci, q in enumerate(r):
                for b in nbrs[q]:
                    if row_of.get(b) == ri - 1:
                        shifts.append(pos[b][0] - ci)
                    elif b not in row_of:
                        for up in nbrs[b]:
                            if row_of.get(up) == ri - 1:
                                shifts.append(pos[up][0] - ci)
                                via_bridge = True
            if shifts:
                offset = sorted(shifts)[len(shifts) // 2]
            y += 2.0 if via_bridge or not shifts else 1.0
        for ci, q in enumerate(r):
            pos[q] = (offset + ci, y)
    for q in range(num_qubits):
        if q in pos:
            continue
        ns = [n for n in nbrs[q] if n in pos]
        if len(ns) >= 2:
            pos[q] = (sum(pos[n][0] for n in ns) / len(ns), sum(pos[n][1] for n in ns) / len(ns))
        elif len(ns) == 1:
            x, yy = pos[ns[0]]
            pos[q] = (x, yy + 1.0)
        else:
            pos[q] = (0.0, -2.0)
    return [[pos[q][0], pos[q][1]] for q in range(num_qubits)]


def _fits(coords, edges, tol=1.05) -> bool:
    """True when every coupled pair is drawn as (near) neighbours and no two qubits coincide."""
    seen = set()
    for x, y in coords:
        key = (round(x, 3), round(y, 3))
        if key in seen:
            return False
        seen.add(key)
    return all(abs(coords[a][0] - coords[b][0]) + abs(coords[a][1] - coords[b][1]) <= tol for a, b in edges)


def qubit_coordinates(backend) -> tuple[list[list[float]], str]:
    """Return ``([x, y] per qubit, method)``; x grows to the right, y downwards."""
    n = backend.num_qubits
    cmap = backend.coupling_map
    edges = {tuple(e) for e in cmap.get_edges()} if cmap is not None else set()
    table = _qiskit_coordinate_tables().get(n)
    if table and len(table) == n:
        coords = [[float(c), float(r)] for r, c in table]  # qiskit stores [row, column]
        if _fits(coords, edges):
            return coords, "qiskit_gate_map"
    if cmap is None:
        return [[float(i), 0.0] for i in range(n)], "linear"
    hh = _heavy_hex_from_graph(n, edges)
    if hh is not None and _fits(hh, edges):
        return hh, "heavy_hex_derived"
    g = rx.PyGraph()
    g.add_nodes_from(range(n))
    g.add_edges_from_no_data(sorted({(min(a, b), max(a, b)) for a, b in edges}))
    layout = rx.spring_layout(g, seed=7, k=1.0)
    return [[float(layout[i][0]) * 3, float(layout[i][1]) * 3] for i in range(n)], "spring"
