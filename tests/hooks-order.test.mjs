// Hooks depois de um "return" antecipado no corpo do componente mudam a contagem de hooks entre renders
// (React #310, tela "Ocorreu um erro ao carregar"). Varredura estática dos componentes em src/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function files(dir) {
  return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : p.endsWith('.tsx') ? [p] : []; });
}

export function hooksAfterReturn(src) {
  const out = [];
  let inComp = false, ret = -1;
  src.split('\n').forEach((l, i) => {
    if (/^(export (default )?)?function [A-Z]/.test(l)) { inComp = true; ret = -1; return; }
    if (/^}/.test(l)) { inComp = false; return; }
    if (!inComp) return;
    if (ret < 0 && /^ {2}if \(.*\)\s*(\{.*)?return\b/.test(l)) ret = i;
    if (ret >= 0 && /^ {2}(const |let )?[^=]*?=?\s*use[A-Z]\w*\(|^ {2}use[A-Z]\w*\(/.test(l)) out.push(i + 1);
  });
  return out;
}

test('detecta hook depois de return antecipado', () => {
  assert.deepEqual(hooksAfterReturn('function A() {\n  const [a] = useState(0);\n  if (!a) return null;\n  useUnsaved(true);\n}\n'), [4]);
  assert.deepEqual(hooksAfterReturn('function A() {\n  useUnsaved(true);\n  if (!a) return null;\n  const x = 1;\n}\n'), []);
});

test('nenhum componente chama hook depois de return antecipado', () => {
  const bad = files('src').flatMap((p) => hooksAfterReturn(readFileSync(p, 'utf8')).map((n) => `${p}:${n}`));
  assert.deepEqual(bad, []);
});
