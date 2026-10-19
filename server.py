"""Flask server for the Qiskit logical-to-physical circuit visualiser.

Run with ``python server.py`` and open http://127.0.0.1:5000/.
"""
from __future__ import annotations

import os
import warnings

warnings.filterwarnings("ignore")

from qviz.web import create_app

app = create_app()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    print(f"Qiskit circuit visualiser: http://127.0.0.1:{port}/")
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
