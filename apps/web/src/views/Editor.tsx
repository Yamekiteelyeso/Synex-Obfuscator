import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, downloadCode } from '../api';
import { highlight } from '../highlight';
import { countLines, formatBytes, validateSource } from '../validate';
import { progressStep, STATUS_LABEL } from '../state';

export interface ProfileInfo { name: string; techniques: string[] }
export interface TechniqueInfo { id: string; label: string; status: 'implemented' | 'partial' | 'pending' }

const MAX_BYTES = 1024 * 1024;
const DEFAULT_CUSTOM = ['identifiers', 'strings'];

interface JobView { id: string; status: string; error?: { code: string; message: string } }

export function Editor({ token, profiles, techniques, maxBytes = MAX_BYTES, initialProfile = 'basic', onDone }: {
  token: string; profiles: ProfileInfo[]; techniques: TechniqueInfo[]; maxBytes?: number; initialProfile?: string; onDone: () => void;
}) {
  const [source, setSource] = useState('');
  const [fileName, setFileName] = useState('script.lua');
  const [profile, setProfile] = useState(initialProfile);
  const [custom, setCustom] = useState<string[]>(DEFAULT_CUSTOM);
  const [job, setJob] = useState<JobView | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const bytes = useMemo(() => new TextEncoder().encode(source).length, [source]);
  const problem = validateSource(source, maxBytes);
  const lines = useMemo(() => Array.from({ length: countLines(source) }, (_, i) => i + 1), [source]);
  const tokens = useMemo(() => highlight(source), [source]);

  // Consulta el estado del trabajo hasta que termina.
  useEffect(() => {
    if (!job || job.status === 'done' || job.status === 'failed' || job.status === 'timeout') return;
    const t = setTimeout(async () => {
      try {
        const r = await api<{ job: any }>('GET', `/api/jobs/${job.id}`, undefined, token);
        const next: JobView = { id: job.id, status: r.job.live ?? r.job.status, error: r.job.error };
        setJob(next);
        if (next.status === 'done') {
          const blob = await downloadCode(job.id, token);
          setResult(await blob.text());
          onDone();
        } else if (next.status === 'failed' || next.status === 'timeout') {
          onDone();
        }
      } catch (e) {
        setMessage(e instanceof ApiError ? e.message : 'se perdió la conexión con el servidor');
        setJob(null);
      }
    }, 600);
    return () => clearTimeout(t);
  }, [job, token]);

  async function start() {
    setMessage(null);
    setResult(null);
    if (problem) return setMessage(problem);
    const body: any = { source, name: fileName, profile };
    if (profile === 'custom') body.custom = { techniques: custom };
    try {
      const r = await api<{ id: string; status: string }>('POST', '/api/jobs', body, token);
      setJob({ id: r.id, status: r.status });
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : 'no se pudo iniciar el trabajo');
    }
  }

  async function importFile(e: any) {
    const f: File | undefined = e.target.files?.[0];
    if (!f) return;
    if (f.size > maxBytes) return setMessage(`el archivo ocupa ${formatBytes(f.size)}; el límite es ${formatBytes(maxBytes)}`);
    setSource(await f.text());
    setFileName(f.name);
    setResult(null);
    setMessage(null);
  }

  function exportResult() {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([result], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName.replace(/\.luau?$/i, '') + '.obf.luau';
    a.click();
    URL.revokeObjectURL(url);
  }

  const busy = job !== null && !['done', 'failed', 'timeout'].includes(job.status);
  const step = job ? progressStep(job.status) : null;
  const available = techniques.filter((t) => t.status !== 'pending');

  return (
    <section className="view">
      <h2>Editor</h2>
      <div className="toolbar">
        <select aria-label="Perfil" value={profile} onChange={(e: any) => setProfile(e.target.value)} disabled={busy}>
          {profiles.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
        </select>
        <button className="btn" onClick={() => fileRef.current?.click()} disabled={busy}>Importar</button>
        <input ref={fileRef} type="file" accept=".lua,.luau,.txt" hidden onChange={importFile} />
        <button className="btn" onClick={() => { setSource(''); setResult(null); setMessage(null); }} disabled={busy}>Limpiar</button>
        <button className="btn primary" onClick={start} disabled={busy || problem !== null}>Ofuscar</button>
        <span className={`size ${problem && source ? 'over' : ''}`}>{formatBytes(bytes)} / {formatBytes(maxBytes)}</span>
      </div>

      {profile === 'custom' && (
        <fieldset className="card techniques">
          <legend>Técnicas</legend>
          {techniques.map((t) => (
            <label key={t.id} className={t.status === 'pending' ? 'disabled' : ''}>
              <input
                type="checkbox"
                disabled={t.status === 'pending' || busy}
                checked={custom.includes(t.id)}
                onChange={(e: any) => setCustom(e.target.checked ? [...custom, t.id] : custom.filter((x) => x !== t.id))}
              />
              {t.label}{t.status === 'pending' ? ' (pendiente)' : t.status === 'partial' ? ' (parcial)' : ''}
            </label>
          ))}
          {available.length === 0 && <p className="error-text">No hay técnicas disponibles.</p>}
        </fieldset>
      )}

      <div className="editor">
        <div className="gutter" aria-hidden="true">{lines.map((n) => <div key={n}>{n}</div>)}</div>
        <div className="code-wrap">
          <pre className="code-layer" aria-hidden="true">
            {tokens.map((t, i) => <span key={i} className={`tk-${t.kind}`}>{t.text}</span>)}{'\n'}
          </pre>
          <textarea
            aria-label="Código Luau"
            spellCheck={false}
            value={source}
            onChange={(e: any) => setSource(e.target.value)}
            onKeyDown={(e: any) => {
              if (e.key === 'Tab') {
                e.preventDefault();
                const el = e.target;
                const { selectionStart: s, selectionEnd: f } = el;
                const v = source.slice(0, s) + '    ' + source.slice(f);
                setSource(v);
                requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 4; });
              }
            }}
          />
        </div>
      </div>

      {problem && source && <p className="error-text" role="alert">{problem}</p>}
      {message && <p className="error-text" role="alert">{message}</p>}

      {step && (
        <div className="card progress" aria-live="polite">
          <div className="progress-head"><span>{STATUS_LABEL[job!.status] ?? job!.status}</span><span>{step.label}</span></div>
          <div className="progress-track"><i style={{ width: `${step.percent}%` }} /></div>
        </div>
      )}

      {result !== null && (
        <div className="card">
          <div className="progress-head">
            <h3>Resultado</h3>
            <button className="btn primary" onClick={exportResult}>Descargar .obf.luau</button>
          </div>
          <p className="muted">{formatBytes(new TextEncoder().encode(result).length)} generados</p>
          <pre className="result">{result}</pre>
        </div>
      )}
    </section>
  );
}
