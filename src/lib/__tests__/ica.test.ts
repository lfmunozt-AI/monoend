/**
 * Tests unitarios — ica.ts
 * Ejecutar: npx tsx src/lib/__tests__/ica.test.ts
 */

import {
  calcularPuntosEvento,
  calcularICA,
  getICALevel,
  getICALabel,
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

test('score 0 → conocimiento_inicial', () => assertEqual(getICALevel(0), 'conocimiento_inicial'));
test('score 30 → conocimiento_inicial', () => assertEqual(getICALevel(30), 'conocimiento_inicial'));
test('score 31 → conocimiento_parcial', () => assertEqual(getICALevel(31), 'conocimiento_parcial'));
test('score 70 → conocimiento_parcial', () => assertEqual(getICALevel(70), 'conocimiento_parcial'));
test('score 71 → conocimiento_pleno', () => assertEqual(getICALevel(71), 'conocimiento_pleno'));
test('score 100 → conocimiento_pleno', () => assertEqual(getICALevel(100), 'conocimiento_pleno'));

// ─── getICALabel ─────────────────────────────────────────────────────────────

console.log('\ngetICALabel');

test('es · score 0 → "Te conozco poco"', () => assertEqual(getICALabel(0, 'es'), 'Te conozco poco'));
test('es · score 50 → "Te voy conociendo"', () => assertEqual(getICALabel(50, 'es'), 'Te voy conociendo'));
test('es · score 100 → "Te conozco a fondo"', () => assertEqual(getICALabel(100, 'es'), 'Te conozco a fondo'));
test('pt · score 0 → "Conheço-te pouco"', () => assertEqual(getICALabel(0, 'pt'), 'Conheço-te pouco'));
test('pt · score 100 → "Conheço-te a fundo"', () => assertEqual(getICALabel(100, 'pt'), 'Conheço-te a fundo'));
test('en · score 0 → "I barely know you"', () => assertEqual(getICALabel(0, 'en'), 'I barely know you'));
test('en · score 100 → "I know you well"', () => assertEqual(getICALabel(100, 'en'), 'I know you well'));

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
