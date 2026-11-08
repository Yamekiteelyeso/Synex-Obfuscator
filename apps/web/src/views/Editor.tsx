import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, downloadCode } from '../api';
import { highlight } from '../highlight';
import { countLines, formatBytes, validateSource } from '../validate';
import { progressStep, STATUS_LABEL } from '../state';

export interface ProfileInfo { name: string; techniques: string[] }
export interface TechniqueInfo { id: string; label: string; status: 'implemented' | 'partial' | 'pending' }

const MAX_BYTES = 1024 * 1024;

interface JobView { id: string; status: string; error?: { code: string; message: string } }

export function Editor({ token, profiles, techniques, maxBytes = MAX_BYTES, initialProfile = 'basic', onDone, remainingUses = null }: {
  token: string; profiles: ProfileInfo[]; techniques: TechniqueInfo[]; maxBytes?: number; initialProfile?: string; onDone: () => void; remainingUses?: number | null;
}) {
  const [source, setSource] = useState('');
  const [fileName, setFileName] = useState('script.lua');
  const [profile, setProfile] = useState(initialProfile);
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

  return (
    <section className="view">
      <div className="editor-heading"><div><p className="eyebrow">WORKSPACE / PROTECCIÓN DE CÓDIGO</p><h2>Ofuscador</h2><p className="muted">Pega o importa tu script Luau y elige un nivel de protección.</p></div><span className="editor-tag">● {remainingUses === null ? 'USO ILIMITADO' : `${remainingUses} OFUSCACIONES RESTANTES`}</span></div>
      <div className="toolbar">
        <select aria-label="Perfil" value={profile} onChange={(e: any) => setProfile(e.target.value)} disabled={busy}>
          {profiles.map((p) => <option key={p.name} value={p.name}>{p.name.toUpperCase()}</option>)}
        </select>
        <button className="btn" onClick={() => fileRef.current?.click()} disabled={busy}>Importar</button>
        <input ref={fileRef} type="file" accept=".lua,.luau,.txt" hidden onChange={importFile} />
        <button className="btn" onClick={() => { setSource(''); setResult(null); setMessage(null); }} disabled={busy}>Limpiar</button>
        <button className="btn primary" onClick={start} disabled={busy || problem !== null || remainingUses === 0}>Ofuscar</button>
        <span className={`size ${problem && source ? 'over' : ''}`}>{formatBytes(bytes)} / {formatBytes(maxBytes)}</span>
      </div>


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

      {remainingUses === 0 && <p className="error-text" role="status">Ya utilizaste tus 2 ofuscaciones Free. Abre la sección Planes para solicitar Premium o Plus.</p>}
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
