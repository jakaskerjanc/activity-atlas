import io
import urllib.error

import pytest

from ingest import garmin_api as ga


class FakeResponse:
    def __init__(self, body): self.body = body
    def read(self): return self.body
    def __enter__(self): return self
    def __exit__(self, *exc): return False


class FakeOpener:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests = []

    def __call__(self, request, timeout=None):
        self.requests.append((request, timeout))
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return FakeResponse(result)


def _api(opener):
    return ga.GarminPersonalApi(
        api_key="secret", base_url="https://api.test", opener=opener
    )


def _http_error(code, body=b"denied"):
    return urllib.error.HTTPError(
        "https://api.test/x", code, "boom", {}, io.BytesIO(body)
    )


def test_resolve_prefers_explicit_key(monkeypatch):
    monkeypatch.setenv("GARMIN_PERSONAL_API_KEY", "env")
    assert ga.resolve_api_key(" explicit ") == "explicit"


def test_resolve_reads_explicit_key_file(tmp_path, monkeypatch):
    monkeypatch.setenv("GARMIN_PERSONAL_API_KEY", "env")
    path = tmp_path / "key"
    path.write_text(" file-key \n")
    assert ga.resolve_api_key(key_file=str(path)) == "file-key"


def test_resolve_explicit_missing_file_does_not_fall_back(tmp_path, monkeypatch):
    monkeypatch.setenv("GARMIN_PERSONAL_API_KEY", "env")
    with pytest.raises(ga.MissingApiKey):
        ga.resolve_api_key(key_file=str(tmp_path / "missing"))


def test_resolve_env_then_default_file(tmp_path, monkeypatch):
    monkeypatch.delenv("GARMIN_PERSONAL_API_KEY", raising=False)
    monkeypatch.setattr(ga, "DEFAULT_KEY_FILE", str(tmp_path / "key"))
    with pytest.raises(ga.MissingApiKey):
        ga.resolve_api_key()
    (tmp_path / "key").write_text("default-key")
    assert ga.resolve_api_key() == "default-key"


def test_authenticate_posts_api_key_and_strips_token():
    opener = FakeOpener(b"jwt.token.value\n")
    api = _api(opener)
    api.authenticate()
    request, _ = opener.requests[0]
    assert request.full_url == "https://api.test" + ga.TOKEN_PATH
    assert request.get_method() == "POST"
    assert request.get_header("Authorization") == "ApiKey secret"
    assert api._token == "jwt.token.value"


def test_list_activities_uses_bearer_and_query_params():
    opener = FakeOpener(b"jwt", b'[{"activityId": 1}]')
    api = _api(opener)
    assert api.list_activities(0, 100) == [{"activityId": 1}]
    request, _ = opener.requests[1]
    assert request.full_url == (
        "https://api.test/activitylist-service/activities/search/activities"
        "?start=0&limit=100"
    )
    assert request.get_header("Authorization") == "Bearer jwt"
    assert request.get_header("Accept") == "application/json"


def test_download_activity_returns_bytes_with_wildcard_accept():
    opener = FakeOpener(b"jwt", b"PK\x03\x04zip")
    api = _api(opener)
    assert api.download_activity(123) == b"PK\x03\x04zip"
    request, _ = opener.requests[1]
    assert request.full_url == "https://api.test/download-service/files/activity/123"
    # The live endpoint returns HTTP 406 for Accept: application/zip.
    assert request.get_header("Accept") == "*/*"


def test_download_activity_rejects_non_numeric_id():
    with pytest.raises(ValueError):
        _api(FakeOpener()).download_activity("abc")


def test_token_401_raises_auth_error():
    api = _api(FakeOpener(_http_error(401)))
    with pytest.raises(ga.GarminAuthError) as exc:
        api.authenticate()
    assert exc.value.status == 401


def test_list_500_raises_api_error():
    api = _api(FakeOpener(b"jwt", _http_error(500)))
    with pytest.raises(ga.GarminApiError) as exc:
        api.list_activities()
    assert exc.value.status == 500


def test_list_non_list_payload_raises():
    api = _api(FakeOpener(b"jwt", b'{"not": "a list"}'))
    with pytest.raises(ga.GarminApiError):
        api.list_activities()
