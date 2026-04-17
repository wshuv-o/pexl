import type { HeaderMatch } from './auto-match';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000';

// ───────────────────────────────────────────────────────────────────────────
// POST /api/automap/match — takes a backend session_id (from the existing
// /api/utility/process upload) + the Excel headers, returns HeaderMatch[] in
// the same shape as the client-side autoMatch() function. Works on scanned
// PDFs because the backend reuses the session's OCR word coordinates.
// ───────────────────────────────────────────────────────────────────────────
export async function matchHeadersBackend(
  sessionId: string,
  headers: string[],
): Promise<HeaderMatch[]> {
  const res = await fetch(`${BACKEND_URL}/api/automap/match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, headers }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`/automap/match ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as HeaderMatch[];
}
