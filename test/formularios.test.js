import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumoFormularios } from '../src/formularios.js';

const forms = [
  { documentId: 10, version: 1000, documentDescription: 'Compras', datasetName: 'dsCompras' },
  { documentId: 20, version: 1000, documentDescription: 'Viagem', datasetName: 'dsViagem' },
];

test('lista e filtra formulários como antes', () => {
  assert.deepEqual(resumoFormularios(forms, 'viag', '000123'), [
    { documentId: 20, version: 1000, description: 'Viagem', dataset: 'dsViagem' },
  ]);
  assert.equal(resumoFormularios(forms, '', '000123').length, 2);
  assert.deepEqual(resumoFormularios(forms, 'nada', '000123'), []);
});

test('servidor sem nenhum formulário para o colaborador vira aviso, não "nada encontrado"', () => {
  const r = resumoFormularios([], '', 'fulano');
  assert.equal(r.total, 0);
  assert.deepEqual(r.formularios, []);
  assert.match(r.aviso, /"fulano"/);
  assert.match(r.aviso, /FLUIG_USERCODE/);
});
