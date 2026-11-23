"""The search text behind the ``text`` filter: per activity, its name, type, place and route names and
Strava descriptions, folded as ``fold_name`` does. Built into a TEMP table on the server's own
connection (``Database._open``), so the ``query`` tool never sees it."""
import json
import re

from .filters import fold_name, has_group_tables

_CASE_CHANGE = re.compile(r"(?<=[a-z])(?=[A-Z])")

# CASE guarantees json_valid runs before json_extract, which raises on text that isn't JSON;
# the order of WHERE terms is not guaranteed.
_DESCRIPTIONS = """
SELECT activity_id, d FROM (
  SELECT activity_id, provider_activity_id,
         CASE WHEN json_valid(summary_json) THEN json_extract(summary_json, '$."Activity Description"') END AS d
  FROM activity_sources
  WHERE provider = 'strava' AND deleted_at IS NULL
)
WHERE d IS NOT NULL AND d != ''
ORDER BY activity_id, provider_activity_id
"""


def split_type(t: str) -> str:
    """The type split into words where a lower-case letter meets an upper-case one."""
    return _CASE_CHANGE.sub(" ", t)


def search_texts(conn) -> dict[str, str]:
    """id → folded search text for every activity, hidden ones included."""
    if has_group_tables(conn):
        rows = conn.execute(
            "SELECT a.id, a.name, a.type, p.name, r.name FROM activities a "
            "LEFT JOIN activity_groups g ON g.activity_id = a.id "
            "LEFT JOIN places p ON p.id = g.place_id "
            "LEFT JOIN route_groups r ON r.id = g.route_id")
    else:
        rows = conn.execute("SELECT id, name, type, NULL, NULL FROM activities")
    parts: dict[str, list[str]] = {}
    for id_, name, type_, place, route in rows:
        parts[id_] = [name, type_, type_ and split_type(type_), place, route]
    for id_, description in conn.execute(_DESCRIPTIONS):
        if id_ in parts:
            parts[id_].append(str(description))
    return {id_: fold_name("\n".join(p for p in ps if p)) for id_, ps in parts.items()}


def words_match(folded: str, words_json: str) -> int:
    """1 when every word of ``json.loads(words_json)`` (already folded) occurs in ``folded`` at a word
    start: position 0, or after a character that is neither a letter nor a digit."""
    for word in json.loads(words_json):
        i = folded.find(word)
        while i > 0 and folded[i - 1].isalnum():
            i = folded.find(word, i + 1)
        if i < 0:
            return 0
    return 1
