import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConstraints, consultaDataset } from '../src/datasetFiltros.js';

const c = (fieldName, initialValue, finalValue, contraintType = 'MUST', likeSearch = false) => (
  { fieldName, initialValue, finalValue, contraintType, likeSearch }
);

test('cada condição vira a constraint do Fluig', () => {
  assert.deepEqual(buildConstraints([
    { field: 'status', op: 'eq', value: 'Aberto' },
    { field: 'status', op: 'ne', value: 'Cancelado' },
    { field: 'nome', op: 'contains', value: 'silva' },
    { field: 'nome', op: 'starts', value: 'Jo' },
    { field: 'email', op: 'ends', value: '.br' },
    { field: 'data', op: 'between', value: '2026-01-01', valueTo: '2026-12-31' },
  ]), [
    c('status', 'Aberto', 'Aberto'),
    c('status', 'Cancelado', 'Cancelado', 'MUST_NOT'),
    c('nome', '%silva%', '%silva%', 'MUST', true),
    c('nome', 'Jo%', 'Jo%', 'MUST', true),
    c('email', '%.br', '%.br', 'MUST', true),
    c('data', '2026-01-01', '2026-12-31'),
  ]);
});

test('match "any" vira SHOULD nas positivas; "ne" continua MUST_NOT', () => {
  assert.deepEqual(buildConstraints([
    { field: 'a', op: 'eq', value: '1' },
    { field: 'b', op: 'contains', value: 'x' },
    { field: 'c', op: 'ne', value: '2' },
  ], 'any'), [c('a', '1', '1', 'SHOULD'), c('b', '%x%', '%x%', 'SHOULD', true), c('c', '2', '2', 'MUST_NOT')]);
});

test('condição desconhecida é erro (não vira igualdade em silêncio)', () => {
  assert.throws(() => buildConstraints([{ field: 'a', op: 'gt', value: '1' }]), /op "gt"/);
  assert.throws(() => buildConstraints([{ field: '', op: 'eq', value: '1' }]), /field/);
});

test('consulta completa: filtros + constraints cruas + serverLimit + ordem', () => {
  assert.deepEqual(consultaDataset({
    fields: ['nome'],
    filters: [{ field: 'nome', op: 'starts', value: 'A' }],
    constraints: [{ field: 'tablename', initial: 'itens', final: 'itens', type: 'MUST' }],
    serverLimit: 50,
    order: { field: 'nome', desc: true },
  }), {
    fields: ['nome'],
    constraints: [
      c('tablename', 'itens', 'itens'),
      c('nome', 'A%', 'A%', 'MUST', true),
      c('sqlLimit', '50', '50'),
    ],
    order: ['nome;desc'],
  });
  assert.deepEqual(consultaDataset({}), { fields: [], constraints: [], order: [] });
});
