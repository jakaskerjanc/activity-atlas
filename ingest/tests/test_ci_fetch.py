import os
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
SCRIPT = os.path.join(ROOT, "scripts", "ci_fetch.sh")


def _git(repo, *args):
    subprocess.run(["git", *args], cwd=repo, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _repo(tmp_path):
    repo = tmp_path / "repo"
    (repo / "data").mkdir(parents=True)
    (repo / "data" / "activities.sqlite").write_bytes(b"orig")
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "t@t")
    _git(repo, "config", "user.name", "t")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "seed")
    return repo


def _stub_python(tmp_path, body):
    path = tmp_path / "pybin"
    path.write_text("#!/usr/bin/env bash\n" + body)
    path.chmod(0o755)
    return str(path)


def test_dry_run_commits_and_pushes_when_db_changed(tmp_path):
    repo = _repo(tmp_path)
    env = {**os.environ, "DRY_RUN": "1",
           "PYTHON_BIN": _stub_python(tmp_path,
                                      "printf x >> data/activities.sqlite\n")}
    out = subprocess.run(["bash", SCRIPT], cwd=repo, env=env,
                         capture_output=True, text=True, check=True).stdout
    assert "DRY: git commit -m chore: garmin fetch" in out
    assert "DRY: git push" in out
    assert "gh secret" not in out


def test_dry_run_no_commit_when_db_unchanged(tmp_path):
    repo = _repo(tmp_path)
    env = {**os.environ, "DRY_RUN": "1",
           "PYTHON_BIN": _stub_python(tmp_path, "true\n")}
    out = subprocess.run(["bash", SCRIPT], cwd=repo, env=env,
                         capture_output=True, text=True, check=True).stdout
    assert "no DB change" in out
    assert "DRY: git push" not in out


def test_fetch_failure_aborts_before_commit(tmp_path):
    repo = _repo(tmp_path)
    env = {**os.environ, "DRY_RUN": "1",
           "PYTHON_BIN": _stub_python(tmp_path, "exit 1\n")}
    result = subprocess.run(["bash", SCRIPT], cwd=repo, env=env,
                            capture_output=True, text=True)
    assert result.returncode != 0
    assert "DRY: git commit" not in result.stdout
