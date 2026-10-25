"""Official Garmin Personal API client — stdlib only (urllib, no third parties).

Personal API key -> bearer token (raw JWT, 24 h) -> activity list + ZIP
downloads. The key is never logged; errors carry status/url only.

Credentials resolve in this order: explicit ``api_key``, explicit ``key_file``,
``GARMIN_PERSONAL_API_KEY`` env, then the same variable in the repo-root
``.env`` (shared with Vite's ``VITE_MAPBOX_TOKEN``). Set
``GARMIN_PERSONAL_API_BASE_URL`` to point the client at a local/test server.

Endpoints (Garmin Connect Personal API):
  POST {base}/personalapitoken-service/personal-api/personal-api-key/token
  GET  {base}/activitylist-service/activities/search/activities?start=&limit=
  GET  {base}/download-service/files/activity/{activityId}
"""
import json
import os
import urllib.error
import urllib.parse
import urllib.request

BASE_URL = "https://personal.connectapi.garmin.com"
TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token"
_LIST_PATH = "/activitylist-service/activities/search/activities"
_DOWNLOAD_PATH = "/download-service/files/activity/"
API_KEY_ENV = "GARMIN_PERSONAL_API_KEY"
BASE_URL_ENV = "GARMIN_PERSONAL_API_BASE_URL"
DOTENV_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
USER_AGENT = "strava-on-maps/0.1"


class GarminApiError(Exception):
    """Any Garmin API failure other than auth; carries status/url when known."""

    def __init__(self, message, *, status=None, url=None):
        super().__init__(message)
        self.status = status
        self.url = url


class GarminAuthError(GarminApiError):
    """HTTP 401/403 — the API key was rejected or the token is stale."""


class MissingApiKey(GarminApiError):
    """No API key was found via any credential source."""


def _read_key_file(path):
    """Read a key file and strip whitespace; None when unreadable or empty."""
    try:
        with open(path, encoding="utf-8") as fh:
            key = fh.read().strip()
    except OSError:
        return None
    return key or None


def _resolve_key_file(path, source):
    key = _read_key_file(os.path.expanduser(path))
    if key is None:
        raise MissingApiKey(f"garmin_api: no usable key in {source} {path!r}")
    return key


def _read_dotenv_key(path):
    """GARMIN_PERSONAL_API_KEY from a KEY=VALUE .env file; None when absent/empty."""
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return None
    for line in lines:
        line = line.strip()
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        name, sep, value = line.partition("=")
        if sep and name.strip() == API_KEY_ENV:
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1].strip()
            return value or None
    return None


def resolve_api_key(api_key=None, *, key_file=None):
    """Return the Personal API key, honouring the documented precedence.

    An explicitly passed api_key/key_file must resolve: there is no fallback
    to env or .env when one of them is missing or empty.
    """
    if api_key is not None:
        key = api_key.strip()
        if not key:
            raise MissingApiKey("garmin_api: explicit api_key is empty")
        return key

    if key_file is not None:
        return _resolve_key_file(key_file, "explicit key_file")

    env = os.environ.get(API_KEY_ENV)
    if env and env.strip():
        return env.strip()

    key = _read_dotenv_key(DOTENV_FILE)
    if key is None:
        raise MissingApiKey(f"garmin_api: no {API_KEY_ENV} in env or {DOTENV_FILE!r}")
    return key


def _http_error(error, request):
    """Map a urllib HTTPError to the typed error hierarchy."""
    status = error.code
    url = error.url or request.full_url
    message = f"garmin_api: HTTP {status} for {url}"
    if status in (401, 403):
        return GarminAuthError(message, status=status, url=url)
    return GarminApiError(message, status=status, url=url)


class GarminPersonalApi:
    """Bearer-token client for the Garmin Personal API.

    The token is obtained lazily: data requests authenticate on first use.
    """

    def __init__(self, *, api_key=None, key_file=None, base_url=None,
                 timeout=30.0, opener=None):
        self._api_key = resolve_api_key(api_key, key_file=key_file)
        self._base_url = (
            base_url or os.environ.get(BASE_URL_ENV) or BASE_URL
        ).rstrip("/")
        self._timeout = timeout
        self._opener = opener or urllib.request.urlopen
        self._token = None

    def _headers(self, **headers):
        base = {"User-Agent": USER_AGENT}
        base.update(headers)
        return base

    def authenticate(self):
        """Exchange the API key for a bearer token, stored as ``self._token``."""
        request = urllib.request.Request(
            self._base_url + TOKEN_PATH,
            data=b"",
            headers=self._headers(Authorization=f"ApiKey {self._api_key}",
                                  Accept="*/*"),
            method="POST",
        )
        body = self._request(request).decode("utf-8").strip()
        url = self._base_url + TOKEN_PATH
        if not body:
            raise GarminApiError("garmin_api: empty token response", url=url)
        self._token = body
        return self._token

    def _token_or_authenticate(self):
        """Bearer token for data requests; authenticate lazily on first use."""
        if self._token is None:
            self.authenticate()
        return self._token

    def _request(self, request):
        """Run one request through the injected opener; map errors to typed ones."""
        try:
            with self._opener(request, timeout=self._timeout) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            raise _http_error(exc, request) from exc
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            raise GarminApiError(
                f"garmin_api: network failure for {request.full_url}: {exc}",
                url=request.full_url,
            ) from exc

    def _get(self, url, **headers):
        request = urllib.request.Request(
            url,
            headers=self._headers(Authorization=f"Bearer {self._token_or_authenticate()}",
                                  **headers),
        )
        return self._request(request)

    def list_activities(self, start=0, limit=100):
        """Fetch one page of SummarizedActivityDTO items (m/s units, newest first)."""
        query = urllib.parse.urlencode({"start": start, "limit": limit})
        url = f"{self._base_url}{_LIST_PATH}?{query}"
        body = self._get(url, Accept="application/json")
        try:
            payload = json.loads(body)
        except ValueError as exc:
            raise GarminApiError(
                f"garmin_api: invalid JSON from {url}: {exc}", url=url
            ) from exc
        if not isinstance(payload, list):
            raise GarminApiError(
                f"garmin_api: expected a JSON list of activities from {url}, "
                f"got {type(payload).__name__}",
                url=url,
            )
        return payload

    def download_activity(self, activity_id):
        """Download one activity's original-file ZIP and return its bytes."""
        try:
            activity_id = int(activity_id)
        except (TypeError, ValueError):
            raise ValueError(
                f"garmin_api: non-numeric activity id: {activity_id!r}"
            ) from None
        url = f"{self._base_url}{_DOWNLOAD_PATH}{activity_id}"
        # The live endpoint returns HTTP 406 for Accept: application/zip.
        return self._get(url, Accept="*/*")
