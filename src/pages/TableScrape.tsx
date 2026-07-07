/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Upload, Plus, Trash2, ScanLine, Download, Loader2, ChevronLeft, ChevronRight, Info } from 'lucide-react';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000';

type Detect = { width: number; height: number; columns: number[]; rows: number[]; word_count: number };
type DragState = { axis: 'col' | 'row'; index: number } | null;

const DISPLAY_MAX_W = 1100; // px the page image is scaled to on screen

export default function TableScrape() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [natural, setNatural] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [columns, setColumns] = useState<number[]>([]);
  const [rows, setRows] = useState<number[]>([]);
  const [uploading, setUploading] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [scraping, setScraping] = useState(false);
  const [table, setTable] = useState<string[][] | null>(null);
  const [firstRowHeader, setFirstRowHeader] = useState(true);
  const [drag, setDrag] = useState<DragState>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const scale = useMemo(() => (natural.w ? Math.min(DISPLAY_MAX_W, natural.w) / natural.w : 1), [natural.w]);
  const dispW = natural.w * scale;
  const dispH = natural.h * scale;
  const pageImgUrl = sessionId ? `${BACKEND_URL}/api/utility/page/${sessionId}/${page}` : '';

  const loadDetect = useCallback(async (sid: string, pg: number) => {
    setDetecting(true);
    setTable(null);
    try {
      const res = await fetch(`${BACKEND_URL}/api/table/detect/${sid}/${pg}`);
      if (!res.ok) { toast.error('Detection failed: ' + (await res.text()).slice(0, 120)); return; }
      const d: Detect = await res.json();
      setNatural({ w: d.width, h: d.height });
      setColumns(d.columns);
      setRows(d.rows);
      if (d.word_count === 0) toast('No text detected on this page — you can still add lines manually.', { icon: 'ℹ️' });
      else toast.success(`Detected ${d.columns.length + 1} columns × ${d.rows.length + 1} rows — drag to calibrate`);
    } catch (e: any) {
      toast.error('Detection error: ' + String(e).slice(0, 120));
    } finally {
      setDetecting(false);
    }
  }, []);

  const onFile = useCallback(async (file: File) => {
    setUploading(true);
    setTable(null); setColumns([]); setRows([]); setSessionId(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${BACKEND_URL}/api/utility/process`, { method: 'POST', body: fd });
      if (!res.ok) { toast.error('Upload failed: ' + (await res.text()).slice(0, 160)); return; }
      const j = await res.json();
      setSessionId(j.session_id);
      setTotalPages(j.total_pages || 1);
      setPage(1);
      await loadDetect(j.session_id, 1);
    } catch (e: any) {
      toast.error('Upload error: ' + String(e).slice(0, 160));
    } finally {
      setUploading(false);
    }
  }, [loadDetect]);

  const gotoPage = useCallback((pg: number) => {
    if (!sessionId || pg < 1 || pg > totalPages) return;
    setPage(pg);
    loadDetect(sessionId, pg);
  }, [sessionId, totalPages, loadDetect]);

  // ---- line dragging ----
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!drag || !wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    if (drag.axis === 'col') {
      const x = Math.max(0, Math.min(natural.w, (e.clientX - rect.left) / scale));
      setColumns(prev => prev.map((v, i) => (i === drag.index ? Math.round(x) : v)));
    } else {
      const y = Math.max(0, Math.min(natural.h, (e.clientY - rect.top) / scale));
      setRows(prev => prev.map((v, i) => (i === drag.index ? Math.round(y) : v)));
    }
  }, [drag, natural.w, natural.h, scale]);

  const endDrag = useCallback(() => setDrag(null), []);

  const addColumn = () => setColumns(prev => [...prev, Math.round(natural.w / 2)].sort((a, b) => a - b));
  const addRow = () => setRows(prev => [...prev, Math.round(natural.h / 2)].sort((a, b) => a - b));
  const delColumn = (i: number) => setColumns(prev => prev.filter((_, idx) => idx !== i));
  const delRow = (i: number) => setRows(prev => prev.filter((_, idx) => idx !== i));

  const doScrape = useCallback(async () => {
    if (!sessionId) return;
    setScraping(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/table/scrape/${sessionId}/${page}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columns, rows }),
      });
      if (!res.ok) { toast.error('Scrape failed: ' + (await res.text()).slice(0, 120)); return; }
      const j = await res.json();
      setTable(j.rows);
      toast.success(`Scraped ${j.rows.length} rows × ${(columns.length + 1)} columns`);
    } catch (e: any) {
      toast.error('Scrape error: ' + String(e).slice(0, 120));
    } finally {
      setScraping(false);
    }
  }, [sessionId, page, columns, rows]);

  const downloadExcel = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await fetch(`${BACKEND_URL}/api/table/excel/${sessionId}/${page}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columns, rows, first_row_header: firstRowHeader }),
      });
      if (!res.ok) { toast.error('Excel failed'); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'table.xlsx'; a.click();
      URL.revokeObjectURL(url);
      toast.success('Excel downloaded');
    } catch (e: any) {
      toast.error('Excel error: ' + String(e).slice(0, 120));
    }
  }, [sessionId, page, columns, rows, firstRowHeader]);

  return (
    <div className="min-h-screen bg-background text-foreground p-5">
      <div className="max-w-[1400px] mx-auto space-y-4">
        <header className="flex items-center gap-3">
          <ScanLine className="w-6 h-6 text-primary" />
          <div>
            <h1 className="text-lg font-bold">Table Scrape (calibrate lines)</h1>
            <p className="text-xs text-muted-foreground">Upload a PDF or photo → adjust the grid lines → scrape the table.</p>
          </div>
          <a href="/" className="ml-auto text-xs text-primary underline">← Back to main</a>
        </header>

        {/* Upload */}
        <div className="flex items-center gap-3 flex-wrap">
          <label className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-primary/40 cursor-pointer hover:bg-primary/5 text-sm">
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            Upload PDF / image
            <input type="file" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.webp,.gif,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*"
                   className="hidden"
                   onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.currentTarget.value = ''; }} />
          </label>

          {sessionId && (
            <>
              <div className="inline-flex items-center gap-1 text-sm">
                <button type="button" aria-label="Previous page" title="Previous page" className="p-1.5 rounded hover:bg-muted disabled:opacity-40" disabled={page <= 1} onClick={() => gotoPage(page - 1)}><ChevronLeft className="w-4 h-4" /></button>
                <span className="tabular-nums">Page {page} / {totalPages}</span>
                <button type="button" aria-label="Next page" title="Next page" className="p-1.5 rounded hover:bg-muted disabled:opacity-40" disabled={page >= totalPages} onClick={() => gotoPage(page + 1)}><ChevronRight className="w-4 h-4" /></button>
              </div>
              <button onClick={addColumn} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs hover:bg-muted"><Plus className="w-3.5 h-3.5" /> Column line</button>
              <button onClick={addRow} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs hover:bg-muted"><Plus className="w-3.5 h-3.5" /> Row line</button>
              <button onClick={doScrape} disabled={scraping || detecting}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50">
                {scraping ? <Loader2 className="w-4 h-4 animate-spin" /> : <ScanLine className="w-4 h-4" />} Scrape
              </button>
              <label className="inline-flex items-center gap-1.5 text-xs">
                <input type="checkbox" checked={firstRowHeader} onChange={e => setFirstRowHeader(e.target.checked)} /> first row = header
              </label>
              <button onClick={downloadExcel} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm hover:bg-muted"><Download className="w-4 h-4" /> Excel</button>
            </>
          )}
        </div>

        {sessionId && (
          <p className="text-[11px] text-muted-foreground flex items-center gap-1">
            <Info className="w-3 h-3" /> Drag any line to move it. Double-click a line to delete it. Blue = columns, green = rows.
          </p>
        )}

        {/* Image + line overlay */}
        {sessionId && natural.w > 0 && (
          <div className="overflow-auto border rounded-lg bg-muted/30">
            <div
              ref={wrapRef}
              className="relative select-none"
              style={{ width: dispW, height: dispH }}
              onMouseMove={onMouseMove}
              onMouseUp={endDrag}
              onMouseLeave={endDrag}
            >
              <img src={pageImgUrl} alt="page" draggable={false}
                   style={{ width: dispW, height: dispH, display: 'block' }} />
              {detecting && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/50 text-sm">
                  <Loader2 className="w-5 h-5 animate-spin mr-2" /> detecting…
                </div>
              )}
              {/* row lines (under columns, so columns win at intersections) */}
              {rows.map((y, i) => (
                <div key={'r' + i}
                     onMouseDown={e => { e.preventDefault(); setDrag({ axis: 'row', index: i }); }}
                     onDoubleClick={() => delRow(i)}
                     title="drag to move · double-click to delete"
                     style={{ position: 'absolute', top: y * scale - 5, left: 0, height: 11, width: dispW, cursor: 'ns-resize', zIndex: 1 }}>
                  <div style={{ position: 'absolute', top: 5, left: 0, height: 1.5, width: '100%', background: 'rgba(22,163,74,0.85)', pointerEvents: 'none' }} />
                </div>
              ))}
              {/* column lines (on top) */}
              {columns.map((x, i) => (
                <div key={'c' + i}
                     onMouseDown={e => { e.preventDefault(); setDrag({ axis: 'col', index: i }); }}
                     onDoubleClick={() => delColumn(i)}
                     title="drag to move · double-click to delete"
                     style={{ position: 'absolute', left: x * scale - 5, top: 0, width: 11, height: dispH, cursor: 'ew-resize', zIndex: 2 }}>
                  <div style={{ position: 'absolute', left: 5, top: 0, width: 1.5, height: '100%', background: 'rgba(37,99,235,0.9)', pointerEvents: 'none' }} />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Result table */}
        {table && (
          <div className="space-y-2">
            <h2 className="text-sm font-semibold">Result — {table.length} rows × {columns.length + 1} columns</h2>
            <div className="overflow-auto border rounded-lg max-h-[420px]">
              <table className="text-xs border-collapse w-full">
                <tbody>
                  {table.map((r, ri) => (
                    <tr key={ri} className={firstRowHeader && ri === 0 ? 'bg-muted font-semibold' : ri % 2 ? 'bg-muted/30' : ''}>
                      {r.map((c, ci) => <td key={ci} className="border px-2 py-1 align-top whitespace-pre-wrap">{c}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {!sessionId && !uploading && (
          <div className="text-sm text-muted-foreground border border-dashed rounded-lg p-8 text-center">
            Upload a PDF or photo to begin. The system will detect the table's grid and draw lines you can adjust.
          </div>
        )}
      </div>
    </div>
  );
}
