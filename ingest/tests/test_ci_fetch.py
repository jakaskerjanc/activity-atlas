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


def _stub_python(tmp_path):
    """Fake PYTHON_BIN: simulates a fetch that changes the DB and rotates the token."""
    p = tmp_path / "pybin"
    p.write_text(
        "#!/usr/bin/env bash\n"
        'printf NEWTOKEN > "$GARMIN_TOKEN_OUT"\n'
        'printf x >> data/activities.sqlite\n'
    )
    p.chmod(0o755)
    return str(p)


def test_dry_run_rotates_and_pushes_when_changed(tmp_path):
    repo = _repo(tmp_path)
    env = {**os.environ,
           "DRY_RUN": "1",
           "PYTHON_BIN": _stub_python(tmp_path),
           "GARMIN_TOKEN": "OLDTOKEN",
           "GARMIN_TOKEN_OUT": str(repo / "token.new")}
    out = subprocess.run(["bash", SCRIPT], cwd=repo, env=env,
                         capture_output=True, text=True, check=True).stdout
    assert "DRY: gh secret set GARMIN_TOKEN" in out    # token differs -> rotate
    assert "DRY: git push" in out                       # DB changed -> push


def test_dry_run_no_rotate_when_token_unchanged(tmp_path):
    repo = _repo(tmp_path)
    env = {**os.environ,
           "DRY_RUN": "1",
           "PYTHON_BIN": _stub_python(tmp_path),
           "GARMIN_TOKEN": "NEWTOKEN",                   # equals what the stub writes
           "GARMIN_TOKEN_OUT": str(repo / "token.new")}
    out = subprocess.run(["bash", SCRIPT], cwd=repo, env=env,
                         capture_output=True, text=True, check=True).stdout
    assert "DRY: gh secret set" not in out
    assert "DRY: git push" in out                        # DB still changed
