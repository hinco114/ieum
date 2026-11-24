import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = Path(os.environ.get("IEUM_RECALL_HOME", "~/.cache/ieum-recall")).expanduser()


def documents(root):
    for path in sorted((root / "memory" / "ieum").glob("*.json")):
        entry = json.loads(path.read_text(encoding="utf8"))
        yield entry["id"], entry["project"] + "\n" + entry["text"], {
            k: entry[k] for k in ("id", "project", "source", "time")}
    for path in sorted((root / "wiki").rglob("*.md")):
        if path.is_symlink() or not path.is_file():
            continue
        source = str(path.relative_to(root))
        identifier = "wiki-" + hashlib.sha256(source.encode()).hexdigest()[:16]
        for i, chunk in enumerate(re.split(r"(?m)(?=^## )", path.read_text(encoding="utf8"))):
            if chunk.strip():
                yield f"{identifier}-{i}", path.stem + "\n" + chunk, {"id": identifier, "source": source}


def index_dir(root):
    return CACHE / "indices" / hashlib.sha256(str(root).encode()).hexdigest()[:20]


def invoke(root, docs, query):
    node = CACHE / "node" / ("node.exe" if os.name == "nt" else "bin/node")
    env = {**os.environ, "IEUM_RECALL_HOME": str(CACHE), "IEUM_INDEX_DIR": str(index_dir(root))}
    payload = {"query": query, "docs": [[key, text] for key, text, _ in docs]}
    proc = subprocess.run([str(node), str(HERE / "recall/query.mjs")], env=env,
                          input=json.dumps(payload), capture_output=True, text=True)
    if proc.returncode:
        raise RuntimeError(proc.stderr[-1500:])
    return json.loads(proc.stdout.strip().splitlines()[-1])


def lock(file):
    if os.name == "nt":
        import msvcrt
        file.seek(0)
        msvcrt.locking(file.fileno(), msvcrt.LK_LOCK, 1)
    else:
        import fcntl
        fcntl.flock(file, fcntl.LOCK_EX)


def start(root, retry=False):
    folder = index_dir(root)
    folder.mkdir(parents=True, exist_ok=True)
    status = folder / "status"
    with (folder / "launch.lock").open("a+b") as gate:
        lock(gate)
        state = status.read_text() if status.exists() else ""
        if state == "ready" or (state.startswith("error") and not retry):
            return state
        if state.startswith("building "):
            try:
                pid = int(state.split()[1])
                if os.name == "nt":
                    import ctypes
                    handle = ctypes.windll.kernel32.OpenProcess(0x00100000, False, pid)
                    if not handle:
                        raise ProcessLookupError(pid)
                    try:
                        if ctypes.windll.kernel32.WaitForSingleObject(handle, 0) == 0:
                            raise ProcessLookupError(pid)
                    finally:
                        ctypes.windll.kernel32.CloseHandle(handle)
                else:
                    os.kill(pid, 0)
                return state
            except ProcessLookupError:
                pass
        with (folder / "setup.log").open("ab") as log:
            child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), str(root)],
                                     stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                     start_new_session=os.name != "nt")
        state = f"building {child.pid}"
        status.write_text(state)
        return state


def prepare(root):
    folder = index_dir(root)
    status = folder / "status"
    with (folder / "launch.lock").open("a+b") as gate:
        lock(gate)
    try:
        with (CACHE / "install.lock").open("a+b") as gate:
            lock(gate)
            node = shutil.which("node")
            if not node:
                raise ValueError("Node.js 18 이상을 설치한 뒤 이음 setup을 다시 실행하세요.")
            subprocess.run([node, str(HERE / "recall/setup.mjs")], check=True,
                           env={**os.environ, "IEUM_RECALL_HOME": str(CACHE)})
        docs = list(documents(root))
        with (folder / "index.lock").open("a+b") as gate:
            lock(gate)
            invoke(root, docs, "준비 확인")
        status.write_text("ready")
    except Exception as exc:
        status.write_text(f"error: {exc}; {folder / 'setup.log'}")
        raise


def search(root, query):
    docs = list(documents(root))
    folder = index_dir(root)
    with (folder / "index.lock").open("a+b") as gate:
        lock(gate)
        ids = invoke(root, docs, query)
    by_id = {key: (text, meta) for key, text, meta in docs}
    out, seen = [], set()
    for key in ids:
        text, meta = by_id[key]
        if meta["id"] not in seen:
            seen.add(meta["id"])
            out.append({**meta, "excerpt": text[:350]})
        if len(out) == 10:
            break
    return out


if __name__ == "__main__":
    prepare(Path(sys.argv[1]))
