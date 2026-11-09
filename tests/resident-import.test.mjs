import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { buildImport, decodeText, parseDelimited, parseXlsx, readTable, unitKey, autoMap } from '../src/lib/resident-import.ts';

// Unidades no formato do condomínio piloto: blocos 1A..15B (sem zero), apartamentos 01..24 e um bloco "1".
const APTOS = ['01', '02', '03', '04', '11', '12', '13', '14', '21', '22', '23', '24'];
const UNITS = [];
for (let b = 1; b <= 15; b++) for (const s of ['A', 'B']) for (const a of APTOS) UNITS.push({ id: `${b}${s}-${a}`, block: `${b}${s}`, label: a, active: true });
for (const a of ['01', '02']) UNITS.push({ id: `1-${a}`, block: '1', label: a, active: true });

// Fixture SINTÉTICA (nomes e contatos inventados).
const CSV = [
  'Unidade;Nome;Tipo;Bloco;Apto;Telefone;Celular;E-mail',
  'BLOCO 01A, N 1;Ana Teste Silva;MORADOR;;;+55 (00) 0000-0000;(11) 98888-0001 | (11) 3333-4444;ana@exemplo.test, ana2@exemplo.test',
  '10A-11;Bruno Ficticio;PROPRIETARIO;;;-;(21)97777-0002;-',
  '1A-1;Carla Inventada;LOCATARIO;;;;;carla@exemplo.test',
  '01/nov;Davi Exemplo;MORADOR;1;11;;(11)96666-0003;',
  '01/nov;Eva Exemplo;MORADOR;2B;12;;(11)96666-0004;',
  '414;Fabio Fora;PROPRIETARIO;;;;(11)95555-0005;',
  '12B;Gil Sem Bloco;MORADOR;;12;;;',
  '3B-4;Hugo Jardim (JARDINEIRO);MORADOR;;;;(11)94444-0006;',
  '3B-4;Iris Autorizada;AUTORIZADO;;;;(11)94444-0007;',
  '5A-21;Jose Vazio (AP VAZIO);PROPRIETARIO;;;;;',
  '5A-22;Lia Fora (NAO MORADOR);PROPRIETARIO;;;;;',
  '6B-23;Maria Filha (FILHA);DEPENDENTE;;;;(11) 9 3333-0008;',
  '6B-23;Maria Filha;RESIDENTE;;;;(11)93333-0009;maria@exemplo.test',
  ';;;;;;;',
  '7A-24;-;MORADOR;;;;;',
  '7A-24;Nina Curta;MORADOR;;;;(11)9222;',
  '99Z-1;Otto Nenhum;MORADOR;;;;;',
].join('\r\n');

test('sintético: unidades, contatos, filtros e motivos', () => {
  const table = parseDelimited(CSV);
  assert.equal(table.length, 17, 'linha vazia some');
  const r = buildImport(table, UNITS);
  const by = Object.fromEntries(r.rows.map((x) => [x.full_name, x]));
  assert.equal(by['Ana Teste Silva'].unit_id, '1A-01');
  assert.equal(by['Ana Teste Silva'].phone, '+5511988880001');
  assert.equal(by['Ana Teste Silva'].email, 'ana@exemplo.test');
  assert.deepEqual(by['Ana Teste Silva'].extra, { phones: ['1133334444'], emails: ['ana2@exemplo.test'] });
  assert.equal(by['Bruno Ficticio'].unit_id, '10A-11');
  assert.equal(by['Bruno Ficticio'].email, null);
  assert.equal(by['Carla Inventada'].unit_id, '1A-01');
  assert.equal(by['Carla Inventada'].phone, null);
  assert.equal(by['Eva Exemplo'].unit_id, '2B-12', 'Unidade corrompida: usa Bloco/Apto');
  assert.equal(by['Maria Filha'].unit_id, '6B-23', 'parêntese de parentesco sai do nome');
  assert.equal(by['Maria Filha'].phone, '+5511933330008');
  assert.equal(by['Maria Filha'].email, 'maria@exemplo.test', 'duplicada junta contatos');
  assert.equal(by['Nina Curta'].phone, null, 'celular truncado não vale');
  assert.equal(r.rows.length, 6);
  assert.deepEqual(r.discards, {
    unidade_ambigua: 2, unidade_inexistente: 2, tipo_excluido: 2, unidade_vazia: 1, nao_morador: 1, duplicado: 1, sem_nome: 1,
  });
  assert.equal(r.total, 16);
  assert.equal(r.withWhatsapp, 4);

  const all = buildImport(table, UNITS, { includeOthers: true });
  assert.equal(all.rows.length, 8, 'checkbox inclui autorizado e jardineiro');
});

test('chave de unidade: zero à esquerda e prefixos', () => {
  assert.equal(unitKey('BLOCO 01A'), '1A');
  assert.equal(unitKey('N 1'), '1');
  assert.equal(unitKey('Apto 011'), '11');
  assert.equal(unitKey('Bl. 3'), '3');
  assert.equal(unitKey('Casa 7'), '7');
});

test('decodificação e separadores', () => {
  const w1252 = new Uint8Array([0x4e, 0x6f, 0x6d, 0x65, 0x3b, 0x45, 0x6e, 0x64, 0x65, 0x72, 0x65, 0xe7, 0x6f]); // Nome;Endereço
  assert.equal(decodeText(w1252), 'Nome;Endereço');
  assert.equal(decodeText(new TextEncoder().encode('\uFEFFNome;Endereço')), 'Nome;Endereço');
  assert.deepEqual(parseDelimited('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseDelimited('a,b\n"x, y",2'), [['a', 'b'], ['x, y', '2']]);
  const m = autoMap(['Qtd', 'Usuario', 'Id', 'Tipo', 'Apelido', 'Unidade', 'Endereço', 'Apto/Num', 'Bloco', 'Ramal', 'Telefone', 'celular', 'cod']);
  assert.deepEqual([m.name, m.kind, m.unit, m.apto, m.block, m.phones], [1, 3, 5, 7, 8, [11, 10]]);
});

test('xlsx mínimo (zip store e deflate) e .xls recusado', async () => {
  const sheet = '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>Tipo</t></is></c></row>'
    + '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>12</v></c></row></sheetData></worksheet>';
  const shared = '<sst><si><t>Unidade</t></si><si><r><t>1A</t></r><r><t>-1 &amp; x</t></r></si></sst>';
  const deflate = async (s) => new Uint8Array(await new Response(new Blob([s]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  const files = [['xl/sharedStrings.xml', new TextEncoder().encode(shared), 0], ['xl/worksheets/sheet1.xml', await deflate(sheet), 8]];
  const parts = [], central = [];
  let off = 0;
  for (const [name, data, method] of files) {
    const n = new TextEncoder().encode(name);
    const local = new Uint8Array(30 + n.length); const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(8, method, true); dv.setUint32(18, data.length, true); dv.setUint16(26, n.length, true); local.set(n, 30);
    const c = new Uint8Array(46 + n.length); const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, method, true); cv.setUint32(20, data.length, true); cv.setUint16(28, n.length, true); cv.setUint32(42, off, true); c.set(n, 46);
    parts.push(local, data); central.push(c); off += local.length + data.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const e = new Uint8Array(22); const ev = new DataView(e.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(10, files.length, true); ev.setUint32(12, cdSize, true); ev.setUint32(16, off, true);
  const zip = new Uint8Array(await new Blob([...parts, ...central, e]).arrayBuffer());
  assert.deepEqual(await parseXlsx(zip), [['Unidade', '', 'Tipo'], ['1A-1 & x', '12']]);
  assert.deepEqual(await readTable(zip, 'x.xlsx'), [['Unidade', '', 'Tipo'], ['1A-1 & x', '12']]);
  await assert.rejects(readTable(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), 'velho.xls'), /xls/);
});

// Arquivos REAIS (dados pessoais): lidos em tempo de execução, nunca copiados; asserts só de contagens/formatos.
const REAL = ['C:/Users/jefferson/Downloads/lista de unidades locatarios.csv', 'C:/Users/jefferson/Downloads/relarorio de moradores.csv'];
for (const path of REAL) {
  test(`arquivo real (contagens): ${path.split('/').pop()}`, { skip: !existsSync(path) && 'arquivo ausente' }, async () => {
    const table = await readTable(new Uint8Array(readFileSync(path)), path);
    const r = buildImport(table, UNITS);
    assert.ok(r.total > 300);
    assert.ok(r.rows.length > 100, 'pessoas válidas');
    assert.ok(r.unitsMatched > 100, 'unidades casadas');
    for (const x of r.rows) {
      assert.ok(UNITS.some((u) => u.id === x.unit_id));
      assert.ok(x.phone === null || /^\+55\d{2}9\d{8}$/.test(x.phone));
      assert.ok(x.email === null || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(x.email));
      assert.ok(x.full_name.length >= 2 && !/[()]/.test(x.full_name));
    }
    const sum = Object.values(r.discards).reduce((a, b) => a + b, 0);
    assert.equal(sum + r.rows.length, r.total, 'toda linha vira pessoa ou descarte');
    // Só agregados no log.
    console.log(JSON.stringify({ arquivo: path.split('/').pop(), linhas: r.total, pessoas: r.rows.length, unidades_planilha: r.unitsSeen,
      unidades_casadas: r.unitsMatched, unidades_com_pessoa: r.unitsWithPeople, unidades_com_whatsapp: r.withWhatsapp, descartes: r.discards }));
  });
}
