import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { highlight } from '../src/highlight';
import { validateSource, formatBytes, countLines } from '../src/validate';
import { progressStep, formatDuration } from '../src/state';
import { Dashboard } from '../src/views/Dashboard';
import { Editor } from '../src/views/Editor';
import { History } from '../src/views/History';
import { Admin } from '../src/views/Admin';
import { AuthView } from '../src/views/Auth';

test('highlight cubre todo el texto original sin pérdidas', () => {
  const src = 'local x = 0x1F -- hola\nprint("a\\"b", [[raw]]) continue\nx += 1';
  const joined = highlight(src).map((t) => t.text).join('');
  assert.equal(joined, src);
});

test('highlight clasifica palabras clave, cadenas, números y comentarios', () => {
  const kinds = Object.fromEntries(highlight('if x then return "s" 1 end -- c').map((t) => [t.text, t.kind]));
  assert.equal(kinds['if'], 'keyword');
  assert.equal(kinds['1'], 'number');
  assert.equal(kinds['"s"'], 'string');
  assert.equal(kinds['x'], 'name');
  assert.equal(highlight('-- c')[0].kind, 'comment');
});

test('validateSource rechaza vacío y tamaños por encima del límite', () => {
  assert.match(validateSource('   ', 100)!, /vacío/);
  assert.equal(validateSource('print(1)', 100), null);
  assert.match(validateSource('x'.repeat(2048), 1024)!, /límite/);
});

test('formatBytes y countLines', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(countLines(''), 1);
  assert.equal(countLines('a\nb\nc'), 3);
});

test('progressStep y formatDuration', () => {
  assert.equal(progressStep('queued').percent, 10);
  assert.equal(progressStep('done').percent, 100);
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(1500), '1.50 s');
});

test('Dashboard muestra métricas y estado vacío', () => {
  const html = renderToStaticMarkup(<Dashboard stats={null} health={null} email="a@b.c" />);
  assert.match(html, /Cargando/);
  const stats = {
    totalJobs: 2, byStatus: { done: 1, failed: 1 }, perProfile: { basic: 2 }, averageProcessingMs: 120,
    latest: [{ id: '1', fileName: 'x.lua', profile: 'basic', status: 'done', createdAt: 0 }],
    recentErrors: [{ id: '2', fileName: 'y.lua', message: 'boom' }],
  };
  const out = renderToStaticMarkup(<Dashboard stats={stats as any} health={{ engine: { running: 1, queued: 0 } }} email="a@b.c" />);
  assert.match(out, /Trabajos totales/);
  assert.match(out, /1 activos/);
  assert.match(out, /boom/);
});

test('Editor ofrece editor de código y no muestra perfiles personalizados', () => {
  const html = renderToStaticMarkup(
    <Editor
      token="t"
      profiles={[{ name: 'basic', techniques: [] }, { name: 'medium', techniques: [] }, { name: 'max', techniques: [] }]}
      techniques={[
        { id: 'identifiers', label: 'Identificadores', status: 'implemented' },
        { id: 'vm', label: 'VM', status: 'pending' },
      ]}
      initialProfile="basic"
      onDone={() => undefined}
    />,
  );
  assert.match(html, /aria-label="Código Luau"/);
  assert.match(html, /legend>Técnicas/);
  assert.match(html, /Identificadores/);
  // La técnica pendiente aparece marcada como pendiente y deshabilitada.
  assert.match(html, /VM \(pendiente\)/);
  assert.match(html, /disabled=""[^>]*\/>VM/);
  const basic = renderToStaticMarkup(<Editor token="t" profiles={[]} techniques={[]} onDone={() => undefined} />);
  assert.doesNotMatch(basic, /legend>Técnicas/);
});

test('History y Admin renderizan estados', () => {
  assert.match(renderToStaticMarkup(<History jobs={null} />), /Cargando/);
  assert.match(renderToStaticMarkup(<History jobs={[]} />), /No hay trabajos/);
  const h = renderToStaticMarkup(<History jobs={[{ id: '1', fileName: 'a.lua', profile: 'basic', status: 'failed', createdAt: 0, error: { message: 'E_X' } }]} />);
  assert.match(h, /E_X/);
  const a = renderToStaticMarkup(
    <Admin data={{ users: [], jobs: [], errors: [], settings: { maxInputBytes: 1048576, enabledProfiles: ['basic'] } }} onToggleProfile={() => undefined} />,
  );
  assert.match(a, /Perfiles habilitados/);
});

test('AuthView muestra el formulario de acceso', () => {
  const html = renderToStaticMarkup(<AuthView onAuth={() => undefined} />);
  assert.match(html, /Iniciar sesión/);
});
