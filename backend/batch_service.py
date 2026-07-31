import os, json, logging
from pathlib import Path
import mysql.connector
from mysql.connector import Error
from dotenv import load_dotenv

load_dotenv(dotenv_path=Path(__file__).parent / ".env", override=True)

logger = logging.getLogger(__name__)

_DB_CONFIG = {
    "host":     os.getenv("DB_HOST",     "localhost"),
    "port":     int(os.getenv("DB_PORT", "3306")),
    "user":     os.getenv("DB_USER",     "root"),
    "password": os.getenv("DB_PASSWORD", ""),
    "database": "odin_db",
}


def _connect():
    return mysql.connector.connect(**_DB_CONFIG)


def _fmt(row: dict) -> dict:
    for k in ("created_at", "updated_at", "changed_at"):
        if row.get(k) and not isinstance(row[k], str):
            row[k] = row[k].isoformat()
    return row


# ---------------------------------------------------------------------------
# Schema migration — concurrency control + version history
# ---------------------------------------------------------------------------
#
# ``batch_records`` originally had no way to tell that a row had changed under
# you: no version, no updated_at, no audit trail. Two people editing the same
# (batch, session, page) simply overwrote each other's whole ``fields`` blob,
# silently — including edits to *different* fields, because each client posts
# its own complete snapshot.
#
# These migrations are additive and idempotent, so they are safe to run on
# every boot and against a database that already has them.

def _column_exists(cur, table: str, column: str) -> bool:
    cur.execute(
        """
        SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s AND COLUMN_NAME = %s
        """,
        (_DB_CONFIG["database"], table, column),
    )
    return (cur.fetchone() or [0])[0] > 0


def ensure_schema() -> None:
    """Add versioning columns and the history table when missing.

    Existing rows get ``version = 1``, which means a client that has never
    seen a version simply behaves as before (see ``upsert_record``).
    """
    conn = _connect()
    try:
        cur = conn.cursor()

        if not _column_exists(cur, "batch_records", "version"):
            cur.execute("ALTER TABLE batch_records ADD COLUMN version INT NOT NULL DEFAULT 1")
            logger.info("migration: batch_records.version added")
        if not _column_exists(cur, "batch_records", "updated_at"):
            cur.execute(
                "ALTER TABLE batch_records ADD COLUMN updated_at TIMESTAMP NULL "
                "DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
            )
            logger.info("migration: batch_records.updated_at added")
        if not _column_exists(cur, "batch_records", "updated_by"):
            cur.execute("ALTER TABLE batch_records ADD COLUMN updated_by VARCHAR(255) NULL")
            logger.info("migration: batch_records.updated_by added")

        cur.execute("""
            CREATE TABLE IF NOT EXISTS batch_record_history (
              id          INT NOT NULL AUTO_INCREMENT,
              batch_id    INT NOT NULL,
              session_id  VARCHAR(255) NOT NULL,
              filename    VARCHAR(500) NULL,
              page        INT NOT NULL,
              version     INT NOT NULL,
              fields      JSON NOT NULL,
              action      VARCHAR(16) NOT NULL DEFAULT 'save',
              changed_by  VARCHAR(255) NULL,
              changed_at  TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (id),
              KEY idx_hist_batch (batch_id, changed_at),
              KEY idx_hist_record (batch_id, session_id, page, version)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
        """)

        conn.commit()
    except Error as e:
        # Never block startup on a migration failure — the app still works
        # without versioning, it just falls back to last-write-wins.
        logger.error("ensure_schema: %s", e)
    finally:
        conn.close()


def _record_history(cur, batch_id: int, session_id: str, filename: str,
                    page: int, version: int, fields: dict,
                    action: str, changed_by: str | None) -> None:
    """Append a snapshot to the audit trail. Best-effort by design: a history
    write must never fail the user's save."""
    try:
        cur.execute(
            """
            INSERT INTO batch_record_history
              (batch_id, session_id, filename, page, version, fields, action, changed_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (batch_id, session_id, filename, page, version,
             json.dumps(fields), action, changed_by),
        )
    except Error as e:
        logger.warning("history write skipped: %s", e)


def create_batch(name: str, created_by: str, doc_type: str | None = None) -> int:
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO batches (name, doc_type, created_by, updated_by) VALUES (%s, %s, %s, %s)",
            (name, doc_type, created_by, created_by),
        )
        conn.commit()
        return cur.lastrowid
    except Error as e:
        logger.error("create_batch: %s", e); raise
    finally:
        conn.close()


def update_batch(batch_id: int, name: str, updated_by: str, doc_type: str | None = None) -> bool:
    # When the caller passes doc_type=None from the API layer we deliberately
    # do NOT touch the column — that lets rename-only PATCHes stay narrow.
    # An explicit clear-to-NULL still works: pass the sentinel "" (empty
    # string) which we normalise to SQL NULL below. The client sends "" or
    # "auto" to fall back to auto-detect.
    conn = _connect()
    try:
        cur = conn.cursor()
        if doc_type is None:
            cur.execute(
                "UPDATE batches SET name=%s, updated_by=%s WHERE id=%s",
                (name, updated_by, batch_id),
            )
        else:
            normalised = None if doc_type in ("", "auto") else doc_type
            cur.execute(
                "UPDATE batches SET name=%s, updated_by=%s, doc_type=%s WHERE id=%s",
                (name, updated_by, normalised, batch_id),
            )
        conn.commit()
        return cur.rowcount > 0
    except Error as e:
        logger.error("update_batch: %s", e); raise
    finally:
        conn.close()


def delete_batch(batch_id: int) -> bool:
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM batches WHERE id=%s", (batch_id,))
        conn.commit()
        return cur.rowcount > 0
    except Error as e:
        logger.error("delete_batch: %s", e); raise
    finally:
        conn.close()


def list_batches() -> list:
    conn = _connect()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute("""
            SELECT b.*, COUNT(r.id) AS record_count
            FROM batches b LEFT JOIN batch_records r ON r.batch_id = b.id
            GROUP BY b.id ORDER BY b.created_at DESC
        """)
        return [_fmt(r) for r in cur.fetchall()]
    except Error as e:
        logger.error("list_batches: %s", e); raise
    finally:
        conn.close()


def get_batch(batch_id: int):
    conn = _connect()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute("SELECT * FROM batches WHERE id=%s", (batch_id,))
        row = cur.fetchone()
        return _fmt(row) if row else None
    except Error as e:
        logger.error("get_batch: %s", e); raise
    finally:
        conn.close()


def upsert_record(
    batch_id: int,
    session_id: str,
    filename: str,
    page: int,
    fields: dict,
    base_version: int | None = None,
    updated_by: str | None = None,
) -> dict:
    """Write one batch record, optionally with optimistic concurrency.

    ``base_version`` is the version the caller last saw.

      * ``None`` — legacy last-write-wins. Existing callers (the bulk importer,
        older clients) keep their previous behaviour exactly.
      * an int — the write only lands if the stored row is still at that
        version. If someone else wrote in the meantime, nothing is modified and
        ``{"status": "conflict", ...}`` is returned with the current server row
        so the caller can show a merge UI instead of silently clobbering.

    Returns ``{"status": "ok", "id", "version"}`` or
    ``{"status": "conflict", "current": {...}}``.
    """
    conn = _connect()
    try:
        cur = conn.cursor(dictionary=True)
        # Lock the row for the read-compare-write so two concurrent saves
        # can't both pass the version check.
        cur.execute(
            "SELECT id, version, fields, filename FROM batch_records "
            "WHERE batch_id=%s AND session_id=%s AND page=%s FOR UPDATE",
            (batch_id, session_id, page),
        )
        existing = cur.fetchone()

        if existing and base_version is not None and int(existing["version"]) != int(base_version):
            current_fields = existing["fields"]
            if isinstance(current_fields, str):
                current_fields = json.loads(current_fields)
            conn.rollback()
            # Re-read outside the aborted transaction for the reporting fields.
            cur.execute(
                "SELECT version, fields, filename, updated_by, updated_at FROM batch_records "
                "WHERE batch_id=%s AND session_id=%s AND page=%s",
                (batch_id, session_id, page),
            )
            row = cur.fetchone() or {}
            if isinstance(row.get("fields"), str):
                row["fields"] = json.loads(row["fields"])
            _fmt(row)
            return {"status": "conflict", "current": row}

        if existing:
            new_version = int(existing["version"]) + 1
            cur.execute(
                "UPDATE batch_records SET filename=%s, fields=%s, version=%s, updated_by=%s "
                "WHERE id=%s",
                (filename, json.dumps(fields), new_version, updated_by, existing["id"]),
            )
            rid = existing["id"]
        else:
            new_version = 1
            cur.execute(
                "INSERT INTO batch_records (batch_id, session_id, filename, page, fields, version, updated_by) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (batch_id, session_id, filename, page, json.dumps(fields), new_version, updated_by),
            )
            rid = cur.lastrowid or 0

        _record_history(cur, batch_id, session_id, filename, page,
                        new_version, fields, "save", updated_by)
        conn.commit()
        return {"status": "ok", "id": rid, "version": new_version}
    except Error as e:
        logger.error("upsert_record: %s", e); raise
    finally:
        conn.close()


def get_record_history(batch_id: int, session_id: str | None = None,
                       page: int | None = None, limit: int = 200) -> list:
    """Change log for a batch, newest first.

    Without ``session_id``/``page`` this is the whole batch's history; with
    them it is one record's timeline.
    """
    conn = _connect()
    try:
        cur = conn.cursor(dictionary=True)
        sql = "SELECT * FROM batch_record_history WHERE batch_id=%s"
        params: list = [batch_id]
        if session_id is not None:
            sql += " AND session_id=%s"; params.append(session_id)
        if page is not None:
            sql += " AND page=%s"; params.append(page)
        sql += " ORDER BY changed_at DESC, id DESC LIMIT %s"
        params.append(int(limit))
        cur.execute(sql, tuple(params))
        rows = cur.fetchall()
        for r in rows:
            if isinstance(r.get("fields"), str):
                r["fields"] = json.loads(r["fields"])
            _fmt(r)
        return rows
    except Error as e:
        # A missing history table must not break the UI that asks for it.
        logger.error("get_record_history: %s", e)
        return []
    finally:
        conn.close()


def bulk_insert_records(batch_id: int, records: list) -> int:
    """Insert many records at once. ``records`` is a list of dicts with keys
    session_id, filename, page, fields. Used by the utility-Excel importer,
    which can add tens of thousands of rows in one shot — an executemany is
    orders of magnitude faster than per-row upserts.

    Inserts in chunks so a single huge packet doesn't exceed MySQL's
    max_allowed_packet. Returns the number of rows inserted.
    """
    if not records:
        return 0
    conn = _connect()
    total = 0
    try:
        cur = conn.cursor()
        CHUNK = 1000
        sql = (
            "INSERT INTO batch_records (batch_id, session_id, filename, page, fields) "
            "VALUES (%s, %s, %s, %s, %s)"
        )
        for i in range(0, len(records), CHUNK):
            chunk = records[i:i + CHUNK]
            params = [
                (batch_id, r["session_id"], r["filename"], r["page"], json.dumps(r["fields"]))
                for r in chunk
            ]
            cur.executemany(sql, params)
            total += cur.rowcount
        conn.commit()
        return total
    except Error as e:
        logger.error("bulk_insert_records: %s", e); raise
    finally:
        conn.close()


def delete_record(batch_id: int, session_id: str, page: int,
                  deleted_by: str | None = None) -> bool:
    conn = _connect()
    try:
        cur = conn.cursor(dictionary=True)
        # Capture what we're about to remove so the audit trail is complete.
        cur.execute(
            "SELECT filename, version, fields FROM batch_records "
            "WHERE batch_id=%s AND session_id=%s AND page=%s",
            (batch_id, session_id, page),
        )
        prior = cur.fetchone()

        cur.execute(
            "DELETE FROM batch_records WHERE batch_id=%s AND session_id=%s AND page=%s",
            (batch_id, session_id, page),
        )
        removed = cur.rowcount > 0

        if removed and prior:
            prior_fields = prior.get("fields")
            if isinstance(prior_fields, str):
                prior_fields = json.loads(prior_fields)
            _record_history(cur, batch_id, session_id, prior.get("filename") or "", page,
                            int(prior.get("version") or 1), prior_fields or {},
                            "delete", deleted_by)
        conn.commit()
        return removed
    except Error as e:
        logger.error("delete_record: %s", e); raise
    finally:
        conn.close()


def get_batch_records(batch_id: int) -> list:
    conn = _connect()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute(
            "SELECT * FROM batch_records WHERE batch_id=%s ORDER BY filename, page",
            (batch_id,),
        )
        rows = cur.fetchall()
        for r in rows:
            if isinstance(r.get("fields"), str):
                r["fields"] = json.loads(r["fields"])
            _fmt(r)
        return rows
    except Error as e:
        logger.error("get_batch_records: %s", e); raise
    finally:
        conn.close()
