import os
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
SCRIPT = os.path.join(ROOT, "scripts", "ci_db.sh")

RO_ENV = {
    "R2_ACCOUNT_ID": "acct123",
    "R2_BUCKET": "my-bucket",
    "R2_RO_ACCESS_KEY_ID": "ro-id",
    "R2_RO_SECRET_ACCESS_KEY": "ro-secret",
    # the read-write pair must never be used for the deploy pull
    "R2_ACCESS_KEY_ID": "rw-id",
    "R2_SECRET_ACCESS_KEY": "rw-secret",
}


def _run(tmp_path, env_extra, aws_body=None, demo=False):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    if aws_body is not None:
        aws = bin_dir / "aws"
        aws.write_text("#!/usr/bin/env bash\n" + aws_body)
        aws.chmod(0o755)
    if demo:
        (tmp_path / "data" / "demo").mkdir(parents=True)
        (tmp_path / "data" / "demo" / "activities.sqlite").write_bytes(b"d")
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("R2_", "AWS_"))}
    env.update({"PATH": f"{bin_dir}:{os.environ['PATH']}", **env_extra})
    return subprocess.run(["bash", SCRIPT], cwd=tmp_path, env=env,
                          capture_output=True, text=True)


def _recording_aws(tmp_path):
    log = tmp_path / "aws.log"
    body = (
        f'{{ echo "ARGS $*"; '
        'echo "ID=$AWS_ACCESS_KEY_ID"; echo "SECRET=$AWS_SECRET_ACCESS_KEY"; '
        'echo "REGION=$AWS_DEFAULT_REGION"; '
        'echo "REQ=$AWS_REQUEST_CHECKSUM_CALCULATION"; '
        'echo "RESP=$AWS_RESPONSE_CHECKSUM_VALIDATION"; '
        f'}} > {log}\n'
        'echo "aws noise on stdout"\n'
    )
    return body, log


def test_pulls_with_read_only_pair(tmp_path):
    body, log = _recording_aws(tmp_path)
    result = _run(tmp_path, RO_ENV, aws_body=body)
    assert result.returncode == 0, result.stderr
    assert result.stdout == "data/activities.sqlite\n"
    lines = log.read_text().splitlines()
    assert lines[0] == (
        "ARGS s3 cp s3://my-bucket/db/activities.sqlite data/activities.sqlite "
        "--endpoint-url https://acct123.r2.cloudflarestorage.com")
    assert "ID=ro-id" in lines
    assert "SECRET=ro-secret" in lines
    assert "REGION=auto" in lines
    assert "REQ=when_required" in lines
    assert "RESP=when_required" in lines


def test_failed_pull_fails(tmp_path):
    result = _run(tmp_path, RO_ENV, aws_body="exit 1\n", demo=True)
    assert result.returncode != 0
    assert result.stdout == ""


def test_demo_fallback(tmp_path):
    result = _run(tmp_path, {}, demo=True)
    assert result.returncode == 0
    assert result.stdout == "data/demo/activities.sqlite\n"


def test_empty_fallback_warns(tmp_path):
    result = _run(tmp_path, {})
    assert result.returncode == 0
    assert result.stdout == "data/activities.sqlite\n"
    assert "::warning::" in result.stderr
    assert "empty" in result.stderr


def _assert_refused(result, tmp_path):
    assert result.returncode != 0
    assert result.stdout == ""
    assert "R2" in result.stderr
    assert not (tmp_path / "aws.log").exists()


def test_bucket_without_ro_pair_fails_not_demo(tmp_path):
    body, _ = _recording_aws(tmp_path)
    env = {"R2_ACCOUNT_ID": "acct123", "R2_BUCKET": "my-bucket",
           "R2_ACCESS_KEY_ID": "rw-id", "R2_SECRET_ACCESS_KEY": "rw-secret"}
    result = _run(tmp_path, env, aws_body=body, demo=True)
    _assert_refused(result, tmp_path)


def test_ro_pair_without_account_fails(tmp_path):
    body, _ = _recording_aws(tmp_path)
    env = {k: v for k, v in RO_ENV.items() if k != "R2_ACCOUNT_ID"}
    result = _run(tmp_path, env, aws_body=body, demo=True)
    _assert_refused(result, tmp_path)


def test_ro_pair_without_bucket_fails(tmp_path):
    body, _ = _recording_aws(tmp_path)
    env = {k: v for k, v in RO_ENV.items() if k != "R2_BUCKET"}
    result = _run(tmp_path, env, aws_body=body, demo=True)
    _assert_refused(result, tmp_path)
