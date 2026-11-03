import os
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
SCRIPT = os.path.join(ROOT, "scripts", "ci_fetch.sh")


def _stub(directory, name, body):
    directory.mkdir(exist_ok=True)
    path = directory / name
    path.write_text("#!/usr/bin/env bash\n" + body)
    path.chmod(0o755)
    return str(path)


def _run(tmp_path, env_extra, python_body="true\n"):
    """Run ci_fetch.sh with stub python and git; git must never be called."""
    bin_dir = tmp_path / "bin"
    log = tmp_path / "calls.log"
    python = _stub(bin_dir, "pybin", f'echo "$@" >> {log}\n' + python_body)
    _stub(bin_dir, "git", f'echo "git $@" >> {tmp_path / "git.log"}\nexit 99\n')
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("R2_") and k != "DB"}
    env.update({"PATH": f"{bin_dir}:{os.environ['PATH']}",
                "PYTHON_BIN": python, **env_extra})
    result = subprocess.run(["bash", SCRIPT], cwd=tmp_path, env=env,
                            capture_output=True, text=True)
    return result, log


def test_skips_without_r2(tmp_path):
    result, log = _run(tmp_path, {})
    assert result.returncode == 0
    assert "::notice::no R2 secrets: the daily fetch needs R2" in result.stdout
    assert not log.exists()


def test_runs_fetch_with_r2(tmp_path):
    result, log = _run(tmp_path, {"R2_BUCKET": "b"})
    assert result.returncode == 0
    assert log.read_text().strip() == \
        "-m ingest.garmin_fetch --db data/activities.sqlite"


def test_fetch_failure_fails_the_job(tmp_path):
    result, _ = _run(tmp_path, {"R2_BUCKET": "b"}, python_body="exit 3\n")
    assert result.returncode == 3


def test_never_touches_git(tmp_path):
    _run(tmp_path, {"R2_BUCKET": "b"})
    _run(tmp_path, {})
    assert not (tmp_path / "git.log").exists()
