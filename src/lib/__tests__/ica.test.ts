/**
 * Tests unitarios — ica.ts
 * Ejecutar: npx tsx src/lib/__tests__/ica.test.ts
 */

import {
  calcularPuntosEvento,
  calcularICA,
  getICALevel,
  getICAColor,
  type Transaccion,
  type Perfil,
  type FiscalProfile,
} from '../ica';

// ─── Mini test runner ────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗  ${name}: ${(e as Error).message}`);
    failed++;
  }
}

function assertEqual<T>(actual: T, expected: T): void {
  if (actual !== expected)
    throw new Error(`esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`);
}

function assertRange(actual: number, min: number, max: number): void {
  if (actual < min || actual > max)
    throw new Error(`${actual} fuera del rango [${min}, ${max}]`);
}

// ─── calcularPuntosEvento ────────────────────────────────────────────────────

console.log('\ncalcularPuntosEvento');

test('transaccion_registrada → 5', () => assertEqual(calcularPuntosEvento('transaccion_registrada'), 5));
test('meta_definida → 10', () => assertEqual(calcularPuntosEvento('meta_definida'), 10));
test('extracto_subido → 15', () => assertEqual(calcularPuntosEvento('extracto_subido'), 15));
test('proyeccion_generada → 20', () => assertEqual(calcularPuntosEvento('proyeccion_generada'), 20));
test('hito_alcanzado → 25', () => assertEqual(calcularPuntosEvento('hito_alcanzado'), 25));
test('evento_desconocido → 0', () => assertEqual(calcularPuntosEvento('evento_desconocido'), 0));

// ─── getICALevel ─────────────────────────────────────────────────────────────

console.log('\ngetICALevel');

test('score 0 → ceguera', () => assertEqual(getICALevel(0), 'ceguera'));
test('score 30 → ceguera', () => assertEqual(getICALevel(30), 'ceguera'));
test('score 31 → vision', () => assertEqual(getICALevel(31), 'vision'));
test('score 70 → vision', () => assertEqual(getICALevel(70), 'vision'));
test('score 71 → dominio', () => assertEqual(getICALevel(71), 'dominio'));
test('score 100 → dominio', () => assertEqual(getICALevel(100), 'dominio'));

// ─── getICAColor ─────────────────────────────────────────────────────────────

console.log('\ngetICAColor');

test('score 15 → rojo #E85C5C', () => assertEqual(getICAColor(15), '#E85C5C'));
test('score 30 → rojo #E85C5C', () => assertEqual(getICAColor(30), '#E85C5C'));
test('score 50 → naranja #E8A93C', () => assertEqual(getICAColor(50), '#E8A93C'));
test('score 70 → naranja #E8A93C', () => assertEqual(getICAColor(70), '#E8A93C'));
test('score 71 → dorado #C9A84C', () => assertEqual(getICAColor(71), '#C9A84C'));
test('score 100 → dorado #C9A84C', () => assertEqual(getICAColor(100), '#C9A84C'));

// ─── calcularICA ─────────────────────────────────────────────────────────────

console.log('\ncalcularICA');

const FISCAL: FiscalProfile = { pais: 'portugal', salarioBruto: 1500, tipoEmpleo: 'conta_outrem' };

const perfilVacio: Perfil = { metas: [], extractosSubidos: 0, proyeccionesGeneradas: 0, hitosAlcanzados: 0 };

test('sin actividad → score 0', () =>
  assertEqual(calcularICA('u1', [], perfilVacio, FISCAL), 0));

test('resultado siempre en rango 0–100', () => {
  const txs: Transaccion[] = Array.from({ length: 100 }, (_, i) => ({
    id: `t${i}`, tipo: 'gasto', monto: 50, categoria: 'alimentación', fecha: '2026-05-01',
  }));
  const perfilMax: Perfil = { metas: Array(10).fill({ id: 'x', nombre: 'x', montoObjetivo: 100, montoActual: 0 }), extractosSubidos: 10, proyeccionesGeneradas: 10, hitosAlcanzados: 10 };
  assertRange(calcularICA('u1', txs, perfilMax, FISCAL), 0, 100);
});

test('score crece con más actividad', () => {
  const tx5: Transaccion[] = Array.from({ length: 5 }, (_, i) => ({
    id: `t${i}`, tipo: 'ingreso', monto: 100, categoria: 'salario', fecha: '2026-05-01',
  }));
  const perfil1: Perfil = { metas: [{ id: 'm1', nombre: 'Fondo', montoObjetivo: 1000, montoActual: 0 }], extractosSubidos: 1, proyeccionesGeneradas: 0, hitosAlcanzados: 0 };
  const score1 = calcularICA('u1', [], perfilVacio, FISCAL);
  const score2 = calcularICA('u1', tx5, perfil1, FISCAL);
  if (score2 <= score1) throw new Error(`score2 (${score2}) debería ser > score1 (${score1})`);
});

// ─── Resumen ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed · ${failed} failed\n`);
if (failed > 0) process.exit(1);
