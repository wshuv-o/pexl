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
    for k in ("created_at", "updated_at"):
        if row.get(k) and not isinstance(row[k], str):
            row[k] = row[k].isoformat()
    return row


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


def upsert_record(batch_id: int, session_id: str, filename: str, page: int, fields: dict) -> int:
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO batch_records (batch_id, session_id, filename, page, fields)
            VALUES (%s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE filename=VALUES(filename), fields=VALUES(fields)
        """, (batch_id, session_id, filename, page, json.dumps(fields)))
        conn.commit()
        return cur.lastrowid or 0
    except Error as e:
        logger.error("upsert_record: %s", e); raise
    finally:
        conn.close()


def delete_record(batch_id: int, session_id: str, page: int) -> bool:
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM batch_records WHERE batch_id=%s AND session_id=%s AND page=%s",
            (batch_id, session_id, page),
        )
        conn.commit()
        return cur.rowcount > 0
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
