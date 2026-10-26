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

test('op só dos OPERADORES: nome herdado do protótipo não vira filtro', () => {
  // O SDK não valida o inputSchema, então o enum de op é só dica para o modelo.
  for (const op of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
    assert.throws(() => buildConstraints([{ field: 'a', op, value: 'x' }]), /op .* inválido/, op);
  }
});

test('filtro sem value é erro; value "" continua valendo para campo vazio', () => {
  assert.throws(() => buildConstraints([{ field: 'status', op: 'eq' }]), /sem value/);
  assert.throws(() => buildConstraints([{ field: 'status', op: 'ne', value: null }]), /sem value/);
  assert.deepEqual(buildConstraints([{ field: 'status', op: 'eq', value: '' }]), [c('status', '', '')]);
});

test('contains/starts/ends recusam value vazio (viraria LIKE "%%", que casa tudo)', () => {
  for (const op of ['contains', 'starts', 'ends']) {
    assert.throws(() => buildConstraints([{ field: 'nome', op, value: '' }]), /vazio/, op);
  }
});

test('between exige value e valueTo (sem valueTo virava igualdade em silêncio)', () => {
  assert.throws(() => buildConstraints([{ field: 'd', op: 'between', value: '2026-01-01' }]), /valueTo/);
  assert.throws(() => buildConstraints([{ field: 'd', op: 'between', value: '2026-01-01', valueTo: '' }]), /valueTo/);
  assert.throws(() => buildConstraints([{ field: 'd', op: 'between', value: '', valueTo: '2026-12-31' }]), /valueTo/);
});

test('match aceita all/any em qualquer caixa; outro valor é erro (não vira E em silêncio)', () => {
  const ab = [{ field: 'a', op: 'eq', value: '1' }, { field: 'b', op: 'eq', value: '2' }];
  assert.deepEqual(buildConstraints(ab, 'ANY').map((k) => k.contraintType), ['SHOULD', 'SHOULD']);
  assert.deepEqual(buildConstraints(ab, 'All').map((k) => k.contraintType), ['MUST', 'MUST']);
  assert.deepEqual(buildConstraints(ab).map((k) => k.contraintType), ['MUST', 'MUST']);
  for (const m of ['or', 'ou', '', 'true']) assert.throws(() => buildConstraints(ab, m), /match .* inválido/, m);
});

test('filters que não é lista é erro claro', () => {
  assert.throws(() => buildConstraints({ field: 'a', op: 'eq', value: '1' }), /filters .* lista/);
  assert.throws(() => consultaDataset({ filters: 'a=1' }), /filters .* lista/);
  assert.deepEqual(consultaDataset({ filters: null }).constraints, []);
});

const crua = (k) => consultaDataset({ constraints: [k] }).constraints;

test('constraint crua: type validado em qualquer caixa; desconhecido é erro (o SOAP viraria MUST)', () => {
  assert.deepEqual(crua({ field: 'a', initial: 'x', type: 'should' }), [c('a', 'x', 'x', 'SHOULD')]);
  assert.deepEqual(crua({ field: 'a', initial: 'x', type: 'Must_Not' }), [c('a', 'x', 'x', 'MUST_NOT')]);
  assert.deepEqual(crua({ field: 'a', initial: 'x' }), [c('a', 'x', 'x', 'MUST')]);
  // "MUST NOT" é o rótulo do seletor da extensão VS Code: no SOAP a exclusão viraria inclusão.
  for (const type of ['MUST NOT', 'NOT', 'OR', '']) {
    assert.throws(() => crua({ field: 'status', initial: 'Cancelado', type }), /type .* inválido/, type);
  }
});

test('constraint crua aceita os nomes do WSDL e exige field', () => {
  assert.deepEqual(crua({
    fieldName: 'colleagueId', initialValue: 'a', finalValue: 'b', contraintType: 'MUST_NOT', likeSearch: 'true',
  }), [c('colleagueId', 'a', 'b', 'MUST_NOT', true)]);
  assert.deepEqual(crua({ field: 'a', initial: '1', final: '9' }), [c('a', '1', '9')]);
  assert.throws(() => crua({ initial: 'x' }), /sem field/);
  assert.throws(() => crua({ field: '  ', initial: 'x' }), /sem field/);
  assert.throws(() => consultaDataset({ constraints: { field: 'a' } }), /constraints .* lista/);
});

test('constraint crua: like só é true com true ou "true" ("false" não vira contém)', () => {
  const like = (v) => crua({ field: 'a', initial: 'x', like: v })[0].likeSearch;
  assert.equal(like(true), true);
  assert.equal(like('true'), true);
  assert.equal(like('TRUE'), true);
  for (const v of ['false', false, undefined, 'sim', 0, 1]) assert.equal(like(v), false, String(v));
});

test('serverLimit inteiro >= 1; fração, zero ou fora do int do servidor é erro', () => {
  assert.deepEqual(consultaDataset({ serverLimit: 5 }).constraints, [c('sqlLimit', '5', '5')]);
  assert.deepEqual(consultaDataset({ serverLimit: '50' }).constraints, [c('sqlLimit', '50', '50')]);
  assert.deepEqual(consultaDataset({ serverLimit: null }).constraints, []);
  // O servidor lê o sqlLimit com Integer.parseInt: "2.5" e "1e+21" quebram lá com falha SOAP obscura.
  for (const n of [0, -1, 2.5, 1e21, 2 ** 31, 'abc', '']) {
    assert.throws(() => consultaDataset({ serverLimit: n }), /serverLimit/, String(n));
  }
});

test('env e limit não entram na consulta ao servidor', () => {
  assert.deepEqual(consultaDataset({ env: 'teste', limit: 3, name: 'colleague' }), { fields: [], constraints: [], order: [] });
});
