import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client, comCliente } from '../src/despacho.js';

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

test('chamadas simultâneas com env diferentes não trocam de cliente no meio', async () => {
  const teste = { env: 'teste', async listar() { await espera(20); return this.env; } };
  const prod = { env: 'prod', async listar() { return this.env; } };
  // Handler no formato dos do server.js: usa `client` antes E depois de um await.
  const handler = async () => {
    const lido = await client.listar();
    return [lido, client.env];
  };

  const [deTeste, deProd] = await Promise.all([comCliente(teste, handler), comCliente(prod, handler)]);
  assert.deepEqual(deTeste, ['teste', 'teste'], 'a chamada de homologação não pode terminar em produção');
  assert.deepEqual(deProd, ['prod', 'prod']);
});

test('métodos chegam ligados ao cliente da chamada', async () => {
  const alvo = { nome: 'x', quem() { return this.nome; } };
  const quem = await comCliente(alvo, async () => client.quem);
  assert.equal(quem(), 'x');
});

test('usar o cliente fora de uma chamada é erro explícito', () => {
  assert.throws(() => client.listar, /fora de uma chamada de ferramenta/);
});
