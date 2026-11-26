"""이음 로컬 기억 도구 (Python 3.9+)."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from contextlib import ExitStack
from datetime import datetime, timezone
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parent))
import recall_client

CONFIG = Path(os.environ.get("IEUM_CONFIG", "~/.config/ieum/config.json")).expanduser()


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False, encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(f.name, path)


def settings():
    if not CONFIG.is_file():
        raise ValueError("먼저 ieum.py setup을 실행하세요.")
    return json.loads(CONFIG.read_text(encoding="utf-8"))


def setup(folder):
    folder = folder or input("기억을 어느 폴더에 저장할까요? ").strip()
    if not folder:
        raise ValueError("저장소 경로를 입력하세요.")
    root = Path(folder).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    save_json(CONFIG, {"memory_root": str(root)})
    return {"memory_root": str(root), "search_engine": recall_client.start(root, retry=True)}


def push_memory(git):
    push_args = ("-c", "push.autoSetupRemote=true", "push", "--porcelain")
    result = git(*push_args, check=False)
    if result.returncode == 0:
        return "push 완료"
    rejected = [line for line in result.stdout.splitlines() if line.startswith("!\t")]
    if len(rejected) != 1 or not rejected[0].endswith(("(fetch first)", "(non-fast-forward)")):
        return "로컬 커밋 · push 대기"
    branch = git("symbolic-ref", "HEAD").stdout.strip()
    if not rejected[0].startswith(f"!\t{branch}:"):
        return "로컬 커밋 · push 대기"

    upstream = git("rev-parse", "--symbolic-full-name", "@{upstream}").stdout.strip()
    push_ref = git("rev-parse", "--symbolic-full-name", "@{push}").stdout.strip()
    if upstream != push_ref:
        return "로컬 커밋 · push 대기"

    git("fetch")
    target = git("rev-parse", upstream).stdout.strip()
    # Check for conflicts without modifying the index or work tree.
    preflight = git("merge-tree", "--write-tree", "HEAD", target, check=False)
    if preflight.returncode == 1:
        return "로컬 커밋 · 원격 변경과 충돌"
    if preflight.returncode:
        return "로컬 커밋 · push 대기"
    merge = git("merge", "--no-autostash", "--strategy=ort",
                "-m", "chore(memory): 원격 변경 병합", target, check=False)
    if merge.returncode:
        return "로컬 커밋 · 원격 변경 반영 실패"

    git(*push_args)
    return "push 완료"


def sync_memory(root, records, entry=None):
    def git(*args, check=True):
        return subprocess.run(["git", "-C", str(root), *args], capture_output=True,
                              text=True, check=check, timeout=25,
                              env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C"})

    git_errors = (OSError, subprocess.SubprocessError)
    rel = str(records.relative_to(root))
    path = records / (entry["id"] + ".json") if entry is not None else None
    with ExitStack() as stack:
        git_ready = False
        status = "로컬 저장 · Git 작업 트리 없음"
        try:
            work_tree = git("rev-parse", "--is-inside-work-tree", check=False)
            if work_tree.stdout.strip() == "true":
                git_dir = Path(git("rev-parse", "--absolute-git-dir").stdout.strip())
                gate = stack.enter_context((git_dir / "ieum-sync.lock").open("a+b"))
                recall_client.lock(gate)
                git_ready = True
        except git_errors:
            status = "로컬 저장 · Git 상태 확인 필요"

        if path is not None:
            save_json(path, entry)
        if not git_ready:
            return status

        try:
            if git("status", "--porcelain", "--untracked-files=all", "--", rel).stdout:
                git("add", "-A", "--", rel)
            if path is not None:
                git("ls-files", "--error-unmatch", "--", str(path.relative_to(root)))
            changes = git("diff", "--cached", "--quiet", "--", rel, check=False)
            if changes.returncode == 1:
                git("commit", "--only", "-m", "chore(memory): 이음 기억 갱신", "--", rel)
            elif changes.returncode:
                return "로컬 저장 · Git 상태 확인 필요"
            if not git("remote").stdout.strip():
                return "로컬 커밋 · Git 원격 없음"
        except git_errors:
            return "로컬 저장 · Git 상태 확인 필요"

        try:
            return push_memory(git)
        except git_errors:
            return "로컬 커밋 · push 대기"


def run(action, args):
    if action == "setup":
        folder = Path(args["folder"]).expanduser()
        if not folder.is_absolute():
            raise ValueError("기억 폴더의 절대 경로를 입력하세요.")
        if CONFIG.exists() and settings()["memory_root"] != str(folder.resolve()):
            raise ValueError("이미 설정된 경로를 변경하려면 CLI setup을 사용하세요.")
        return setup(str(folder))
    root = Path(settings()["memory_root"]).resolve()
    records = root / "memory" / "ieum"
    if action == "sync":
        return {"sync": sync_memory(root, records)}
    if action in ("remember", "project_update"):
        body = args["text"].strip()
        project = args.get("project", "").strip()
        if not body or (action == "project_update" and not project):
            raise ValueError("내용과 프로젝트 상태에 필요한 프로젝트명을 입력하세요.")
        entry = {"id": uuid4().hex, "kind": action, "text": body, "project": project,
                 "source": args.get("source", ""), "time": datetime.now(timezone.utc).isoformat()}
        return {**entry, "sync": sync_memory(root, records, entry)}
    if action == "search_status":
        return {"engine": recall_client.start(root), "log": str(recall_client.index_dir(root) / "setup.log")}
    if action == "search" and args["query"].strip() and recall_client.start(root) == "ready":
        try:
            return recall_client.search(root, args["query"])
        except RuntimeError as exc:
            raise ValueError(f"검색 엔진 오류: {exc}") from exc
    entries = [json.loads(p.read_text(encoding="utf-8")) for p in records.glob("*.json")]
    entries.sort(key=lambda e: e["time"], reverse=True)
    if action == "overview":
        latest = {}
        for e in entries:
            if e["kind"] == "project_update":
                latest.setdefault(e["project"], e)
        return list(latest.values())
    if action != "search":
        raise ValueError("알 수 없는 도구")
    terms = re.findall(r"\w+", args["query"].casefold())
    if not terms:
        raise ValueError("검색어를 입력하세요.")
    matches = []

    def consider(content, record):
        folded = content.casefold()
        hits = [term for term in terms if term in folded]
        if hits:
            start = max(0, folded.find(hits[0]) - 80)
            matches.append((len(hits), {**record, "excerpt": content[start:start + 350]}))

    for e in entries:
        consider(e["project"] + " " + e["text"], {k: e[k] for k in ("id", "project", "source", "time")})
    for path in sorted((root / "wiki").rglob("*.md")):
        if path.is_file() and not path.is_symlink():
            source = str(path.relative_to(root))
            consider(path.stem + "\n" + path.read_text(encoding="utf-8"),
                     {"source": source, "id": "wiki-" + hashlib.sha256(source.encode()).hexdigest()[:16]})
    return [record for _, record in sorted(matches, key=lambda pair: -pair[0])[:10]]


DEFS = {
    "search_status": ("검색 엔진의 준비 상태와 로그 경로를 확인한다.", [], []),
    "setup": ("사용자에게 기억 폴더를 물은 뒤 사용자가 선택한 절대 경로로 처음 설정한다.", ["folder"], []),
    "remember": ("사용자가 지정한 기억과 근거를 저장한다.", ["text"], ["project", "source"]),
    "sync": ("기억 폴더의 변경을 커밋하고 미전송 커밋을 원격에 push한다.", [], []),
    "search": ("공용 기억과 위키를 한국어 키워드와 의미로 검색한다. 준비 중에는 키워드를 사용한다.", ["query"], []),
    "project_update": ("프로젝트의 최신 작업 상태를 기록한다.", ["project", "text"], ["source"]),
    "overview": ("프로젝트별 마지막 상태를 읽는다.", [], []),
}


def mcp():
    tools = [{"name": name, "description": desc, "inputSchema": {
        "type": "object", "properties": {k: {"type": "string"} for k in required + optional},
        "required": required, "additionalProperties": False}} for name, (desc, required, optional) in DEFS.items()]
    for line in sys.stdin:
        request_id = None
        try:
            req = json.loads(line)
            if "id" not in req:
                continue
            request_id = req["id"]
            method = req["method"]
            if method == "initialize":
                versions = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
                version = req.get("params", {}).get("protocolVersion")
                result = {"protocolVersion": version if version in versions else versions[0],
                          "capabilities": {"tools": {}}, "serverInfo": {"name": "ieum", "version": "0.2.1"}}
            elif method == "tools/list":
                result = {"tools": tools}
            elif method == "ping":
                result = {}
            elif method == "tools/call":
                params = req["params"]
                try:
                    name = params["name"]
                    args = params.get("arguments", {})
                    _, required, optional = DEFS[name]
                    if not isinstance(args, dict) or set(args) - set(required + optional) or not all(
                            isinstance(args.get(k), str) for k in set(required) | set(args)):
                        raise ValueError("도구 인자를 확인하세요.")
                    value = run(name, args)
                    result = {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}]}
                except (KeyError, ValueError, OSError) as exc:
                    result = {"isError": True, "content": [{"type": "text", "text": str(exc)}]}
            else:
                raise LookupError(method)
            reply = {"result": result}
        except (KeyError, LookupError, ValueError, TypeError) as exc:
            reply = {"error": {"code": -32601 if isinstance(exc, LookupError) else -32600, "message": str(exc)}}
        print(json.dumps({"jsonrpc": "2.0", "id": request_id, **reply}, ensure_ascii=False), flush=True)


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    commands = cli.add_subparsers(dest="command", required=True)
    commands.add_parser("setup").add_argument("folder", nargs="?")
    commands.add_parser("mcp")
    for name, (desc, required, optional) in DEFS.items():
        if name == "setup":
            continue
        parser = commands.add_parser(name, help=desc)
        for k in required:
            parser.add_argument(k)
        for k in optional:
            parser.add_argument("--" + k, default="")
    args = vars(cli.parse_args())
    action = args.pop("command")
    if action == "mcp":
        mcp()
        return
    result = setup(args["folder"]) if action == "setup" else run(action, args)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        sys.exit(str(error))
