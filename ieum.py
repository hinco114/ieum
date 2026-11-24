"""이음 CLI 진입점."""
from pathlib import Path
import runpy

if __name__ == "__main__":
    runpy.run_path(str(Path(__file__).resolve().parent / "plugins/ieum/ieum.py"), run_name="__main__")
