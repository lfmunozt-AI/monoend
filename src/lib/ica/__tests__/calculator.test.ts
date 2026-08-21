/**
 * Tests unitarios — src/lib/ica/calculator.ts
 *
 * Ejecutar: npx tsx src/lib/ica/__tests__/calculator.test.ts
 *
 * Cobertura:
 *  - Usuario nuevo (todo a 0)
 *  - Usuario completo con 12 meses (cerca de 100)
 *  - Una prueba focalizada por dimensión
 *  - Edge cases: sin categorías declaradas, sin queries Consigliere
 *  - Niveles narrativos
 */

import { computeICAFromData, type ICAInputs } from '../calculator';
import type { ICAResult } from '../types';

// ─── Mini runner ─────────────────────────────────────────────────────────────

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

function assertEqual<T>(actual: T, expected: T, msg?: string): void {
  if (actual !== expected) {
    throw new Error(
      `${msg ? msg + ': ' : ''}esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`,
    );
  }
}

function assertRange(actual: number, min: number, max: number, msg?: string): void {
  if (actual < min || actual > max) {
    throw new Error(`${msg ? msg + ': ' : ''}${actual} fuera del rango [${min}, ${max}]`);
  }
}

function assertGreater(a: number, b: number, msg?: string): void {
  if (!(a > b)) throw new Error(`${msg ? msg + ': ' : ''}${a} no es mayor que ${b}`);
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW = new Date('2026-05-28T12:00:00Z');

function emptyInputs(): ICAInputs {
  return {
    profile: null,
    fiscal: null,
    goals: [],
    transactions: [],
    userMessagesLast30d: 0,
  };
}

function fullProfile() {
  return {
    name: 'Luis',
    country: 'PT',
    language: 'es',
    onboarding_done: true,
    created_at: '2025-06-01T00:00:00Z',
  };
}

function fullFiscal() {
  return {
    country: 'portugal',
    employment_type: 'conta_outrem',
    monthly_gross: 2500,
  };
}

function run(inputs: ICAInputs): ICAResult {
  return computeICAFromData(inputs, NOW);
}

/** Genera N transacciones distribuidas en los últimos `months` meses. */
function spreadTxs(months: number, perMonth = 2): ICAInputs['transactions'] {
  const out: ICAInputs['transactions'] = [];
  for (let m = 0; m < months; m++) {
    const d = new Date(NOW);
    d.setUTCMonth(d.getUTCMonth() - m);
    for (let i = 0; i < perMonth; i++) {
      const day = String(Math.min(28, 1 + i * 7)).padStart(2, '0');
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dateStr = `${d.getUTCFullYear()}-${mm}-${day}`;
      out.push({
        type: i % 2 === 0 ? 'income' : 'expense',
        category: ['alimentacion', 'vivienda', 'transporte', 'ocio', 'otros'][i % 5],
        date: dateStr,
      });
    }
  }
  return out;
}

// ─── Casos extremos ──────────────────────────────────────────────────────────

console.log('\nICA: usuario nuevo y usuario maduro');

test('usuario recién registrado (nada declarado) → score 0', () => {
  const r = run(emptyInputs());
  assertEqual(r.score, 0);
  assertEqual(r.components.perfilCompleto, 0);
  assertEqual(r.components.profundidadHistorica, 0);
  assertEqual(r.components.diversidadFuentes, 0);
  assertEqual(r.components.consistencia, 0);
  assertEqual(r.components.engagement, 0);
});

test('usuario maduro (perfil + 12 meses tx + queries) → score ≥ 80', () => {
  const inputs: ICAInputs = {
    profile: fullProfile(),
    fiscal: fullFiscal(),
    goals: [{ category: 'emergency_fund', status: 'active' }],
    transactions: spreadTxs(12, 4),
    userMessagesLast30d: 40,
  };
  const r = run(inputs);
  assertGreater(r.score, 80);
  assertEqual(r.narrativeLevel, 'Dominio total');
});

test('score acotado a [0,100] en cualquier escenario', () => {
  const inputs: ICAInputs = {
    profile: fullProfile(),
    fiscal: fullFiscal(),
    goals: Array(20).fill({ category: 'other', status: 'active' }),
    transactions: spreadTxs(24, 30),
    userMessagesLast30d: 10_000,
  };
  const r = run(inputs);
  assertRange(r.score, 0, 100);
});

// ─── Dimensión 1: perfilCompleto ─────────────────────────────────────────────

console.log('\nICA: perfilCompleto');

test('perfilCompleto → todos los 7 campos → 100', () => {
  const r = run({
    ...emptyInputs(),
    profile: fullProfile(),
    fiscal: fullFiscal(),
  });
  assertEqual(r.components.perfilCompleto, 100);
});

test('perfilCompleto → solo profile sin fiscal → ~57 (4/7)', () => {
  const r = run({ ...emptyInputs(), profile: fullProfile(), fiscal: null });
  assertEqual(r.components.perfilCompleto, 57);
});

test('perfilCompleto → profile null → 0', () => {
  const r = run({ ...emptyInputs(), profile: null });
  assertEqual(r.components.perfilCompleto, 0);
});

// ─── Dimensión 2: profundidadHistorica ──────────────────────────────────────

console.log('\nICA: profundidadHistorica');

test('profundidadHistorica → 0 meses → 0', () => {
  const r = run(emptyInputs());
  assertEqual(r.components.profundidadHistorica, 0);
});

test('profundidadHistorica → 12 meses → 100', () => {
  const r = run({ ...emptyInputs(), transactions: spreadTxs(12, 1) });
  assertEqual(r.components.profundidadHistorica, 100);
});

test('profundidadHistorica → 6 meses → 50', () => {
  const r = run({ ...emptyInputs(), transactions: spreadTxs(6, 1) });
  assertEqual(r.components.profundidadHistorica, 50);
});

// ─── Dimensión 3: diversidadFuentes ─────────────────────────────────────────

console.log('\nICA: diversidadFuentes');

test('diversidadFuentes → sin categorías ni tipos → 0', () => {
  const r = run({
    ...emptyInputs(),
    transactions: [{ type: 'income', category: null, date: '2026-05-01' }],
  });
  // 1 tipo, sin categoría, sin mix → 0 categorías reales en set
  assertEqual(r.components.diversidadFuentes, 0);
});

test('diversidadFuentes → 5 categorías distintas → 100', () => {
  const cats = ['alimentacion', 'vivienda', 'transporte', 'ocio', 'otros'];
  const txs = cats.map((c, i) => ({
    type: 'expense' as const,
    category: c,
    date: `2026-05-${String(10 + i).padStart(2, '0')}`,
  }));
  const r = run({ ...emptyInputs(), transactions: txs });
  assertEqual(r.components.diversidadFuentes, 100);
});

test('diversidadFuentes → income+expense suma "fuente" extra', () => {
  // 1 categoría + mix income/expense → 2 fuentes → 40
  const txs = [
    { type: 'income' as const, category: 'salario', date: '2026-05-01' },
    { type: 'expense' as const, category: 'salario', date: '2026-05-02' },
  ];
  const r = run({ ...emptyInputs(), transactions: txs });
  assertEqual(r.components.diversidadFuentes, 40);
});

// ─── Dimensión 4: consistencia ──────────────────────────────────────────────

console.log('\nICA: consistencia');

test('consistencia → sin transacciones → 0', () => {
  const r = run(emptyInputs());
  assertEqual(r.components.consistencia, 0);
});

test('consistencia → 8 semanas distintas con actividad → 100', () => {
  const txs: ICAInputs['transactions'] = [];
  for (let w = 0; w < 8; w++) {
    const d = new Date(NOW);
    d.setUTCDate(d.getUTCDate() - w * 7 - 1);
    txs.push({
      type: 'expense',
      category: 'x',
      date: d.toISOString().slice(0, 10),
    });
  }
  const r = run({ ...emptyInputs(), transactions: txs });
  assertEqual(r.components.consistencia, 100);
});

test('consistencia → 4 semanas activas → 50', () => {
  const txs: ICAInputs['transactions'] = [];
  for (let w = 0; w < 4; w++) {
    const d = new Date(NOW);
    d.setUTCDate(d.getUTCDate() - w * 7 - 1);
    txs.push({
      type: 'expense',
      category: 'x',
      date: d.toISOString().slice(0, 10),
    });
  }
  const r = run({ ...emptyInputs(), transactions: txs });
  assertEqual(r.components.consistencia, 50);
});

// ─── Dimensión 5: engagement ────────────────────────────────────────────────

console.log('\nICA: engagement');

test('engagement → 0 queries → 0', () => {
  const r = run(emptyInputs());
  assertEqual(r.components.engagement, 0);
});

test('engagement → 25 queries → 80', () => {
  const r = run({ ...emptyInputs(), userMessagesLast30d: 25 });
  assertEqual(r.components.engagement, 80);
});

test('engagement → ≥40 queries → 100 (satura)', () => {
  const r = run({ ...emptyInputs(), userMessagesLast30d: 999 });
  assertEqual(r.components.engagement, 100);
});

// ─── Niveles narrativos ─────────────────────────────────────────────────────

console.log('\nICA: niveles narrativos');

test('narrativeLevel → score 0 → "Apenas comenzando"', () => {
  const r = run(emptyInputs());
  assertEqual(r.narrativeLevel, 'Apenas comenzando');
});

test('narrativeLevel → score >60 → "Visión clara" o superior', () => {
  const r = run({
    ...emptyInputs(),
    profile: fullProfile(),
    fiscal: fullFiscal(),
    transactions: spreadTxs(12, 4),
    userMessagesLast30d: 25,
  });
  if (!['Visión clara', 'Dominio total'].includes(r.narrativeLevel)) {
    throw new Error(`narrativeLevel inesperado: ${r.narrativeLevel} (score=${r.score})`);
  }
});

// ─── Edge cases explícitos del briefing ─────────────────────────────────────

console.log('\nICA: edge cases');

test('sin categorías budget declaradas (txs sin categoría) → diversidad baja', () => {
  const txs: ICAInputs['transactions'] = [
    { type: 'expense', category: null, date: '2026-05-01' },
    { type: 'expense', category: null, date: '2026-05-02' },
  ];
  const r = run({ ...emptyInputs(), transactions: txs, profile: fullProfile() });
  assertEqual(r.components.diversidadFuentes, 0);
});

test('sin queries al Consigliere → engagement=0 pero score puede ser >0 por otras dim.', () => {
  const r = run({
    ...emptyInputs(),
    profile: fullProfile(),
    fiscal: fullFiscal(),
    transactions: spreadTxs(6, 1),
    userMessagesLast30d: 0,
  });
  assertEqual(r.components.engagement, 0);
  assertGreater(r.score, 0);
});

test('goals con category alimentan diversidadFuentes', () => {
  const r = run({
    ...emptyInputs(),
    goals: [
      { category: 'emergency_fund', status: 'active' },
      { category: 'property', status: 'active' },
    ],
    transactions: [
      { type: 'expense', category: 'alimentacion', date: '2026-05-10' },
      { type: 'expense', category: 'vivienda', date: '2026-05-11' },
      { type: 'expense', category: 'transporte', date: '2026-05-12' },
    ],
  });
  // 3 cats tx + 2 cats goal = 5, cap 5 → 100
  assertEqual(r.components.diversidadFuentes, 100);
});

// ─── Resumen ─────────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n${passed} passed · ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}, 50);
