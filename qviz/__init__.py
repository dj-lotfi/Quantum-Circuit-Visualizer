"""Qiskit logical-to-physical circuit visualiser.

The public API is intentionally small:

>>> from qviz import compile_circuit
>>> model = compile_circuit(circuit, backend)
"""

from .engine import CompileError, Compiler


def compile_circuit(circuit, backend, *, seed: int = 11, layout_method: str = "sabre",
                    routing_method: str = "sabre", simulate: bool = True,
                    sim_seed: int = 1234):
    """Compile a Qiskit circuit and return the JSON-serialisable visualisation model."""
    return Compiler(
        backend,
        seed=seed,
        layout_method=layout_method,
        routing_method=routing_method,
    ).compile(circuit, simulate=simulate, sim_seed=sim_seed)


def display(circuit, backend, **kwargs):
    """Display a fixed circuit/backend pair in Jupyter."""
    from .notebook import display_circuit

    return display_circuit(circuit, backend, **kwargs)


def interactive(*, height: int = 900, width: str = "100%"):
    """Open the editable QViz workspace without supplying a circuit or backend."""
    from .notebook import interactive_display

    return interactive_display(height=height, width=width)


__all__ = ["CompileError", "Compiler", "compile_circuit", "display", "interactive"]
