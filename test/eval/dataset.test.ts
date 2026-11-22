import { describe, it, expect } from 'vitest';
import {
  generateDataset,
  generateScaleDataset,
  createSeededRandom,
} from '../../src/eval/gen-dataset.js';

describe('Evaluation Dataset Generator v2 (§8.2)', () => {
  it('should deterministically generate >= 140 unique evaluation cases', () => {
    const ds1 = generateDataset(12345);
    const ds2 = generateDataset(12345);

    expect(ds1.length).toBeGreaterThanOrEqual(140);
    expect(ds1.length).toBe(ds2.length);
    expect(JSON.stringify(ds1)).toBe(JSON.stringify(ds2));
  });

  it('should have ZERO duplicate IDs and ZERO duplicate queries', () => {
    const ds = generateDataset();
    const idSet = new Set(ds.map((c) => c.id));
    const normQuerySet = new Set(ds.map((c) => c.query.trim().toLowerCase()));

    expect(idSet.size).toBe(ds.length);
    expect(normQuerySet.size).toBe(ds.length);
  });

  it('should cover all 7 Eval v2 suites with expected case counts', () => {
    const ds = generateDataset();
    const suiteCounts: Record<string, number> = {};
    for (const c of ds) {
      suiteCounts[c.suite] = (suiteCounts[c.suite] || 0) + 1;
    }

    expect(suiteCounts['factual']).toBe(30);
    expect(suiteCounts['temporal']).toBe(30);
    expect(suiteCounts['procedural']).toBe(30);
    expect(suiteCounts['implicit']).toBe(30);
    expect(suiteCounts['english_mixed']).toBe(12);
    expect(suiteCounts['isolation_multihop']).toBe(12);
    expect(suiteCounts['budget_viking']).toBe(8);
  });

  it('should enforce equal utility (0.5) and >= 15 distractors on factual positive cases', () => {
    const ds = generateDataset();
    const factualPos = ds.filter((c) => c.suite === 'factual' && c.expect.include.length > 0);
    expect(factualPos.length).toBe(27);

    for (const c of factualPos) {
      expect(c.setup.length).toBeGreaterThanOrEqual(16); // 1 target + >= 15 distractors
      for (const item of c.setup) {
        expect(item.utility).toBe(0.5);
      }
    }
  });

  it('should contain >= 20 critical cases and >= 12 empty-threshold cases', () => {
    const ds = generateDataset();
    const criticalCount = ds.filter((c) => c.critical).length;
    const emptyCount = ds.filter((c) => c.expect.include.length === 0).length;

    expect(criticalCount).toBeGreaterThanOrEqual(20);
    expect(emptyCount).toBeGreaterThanOrEqual(12);
  });

  it('should include natural English, mixed-language, and 60+ char Chinese prompts in english_mixed', () => {
    const ds = generateDataset();
    const enSuite = ds.filter((c) => c.suite === 'english_mixed');
    expect(enSuite.length).toBe(12);

    const hasNaturalEnglish = enSuite.some((c) =>
      c.query.includes('Can you please help me remember what port our backend listens on?')
    );
    const longChinesePrompts = enSuite.filter((c) => c.query.length >= 60);

    expect(hasNaturalEnglish).toBe(true);
    expect(longChinesePrompts.length).toBeGreaterThanOrEqual(4);
  });

  it('should include isolation, graph relations, and prompt sanitization in isolation_multihop', () => {
    const ds = generateDataset();
    const isoSuite = ds.filter((c) => c.suite === 'isolation_multihop');
    expect(isoSuite.length).toBe(12);

    expect(isoSuite.some((c) => c.excludeWorkspaces && c.excludeWorkspaces.length > 0)).toBe(true);
    expect(isoSuite.some((c) => c.setup.some((s) => s.scope === 'session'))).toBe(true);
    expect(isoSuite.some((c) => c.setup.some((s) => s.status === 'candidate'))).toBe(true);
    expect(isoSuite.some((c) => c.relations && c.relations.length > 0)).toBe(true);
    expect(isoSuite.some((c) => c.setup.some((s) => s.content.includes('</memory_context>')))).toBe(
      true
    );
    expect(isoSuite.some((c) => c.setup.some((s) => s.content.includes('\u202e')))).toBe(true);
  });

  it('should have valid structure for every case and deterministic seeded RNG', () => {
    const r1 = createSeededRandom(99);
    const r2 = createSeededRandom(99);
    expect(r1()).toBe(r2());

    const ds = generateDataset();
    for (const c of ds) {
      expect(c.id).toBeTruthy();
      expect(c.suite).toBeTruthy();
      expect(c.query.length).toBeGreaterThan(0);
      expect(c.workspace).toBeTruthy();
      expect(Number.isFinite(new Date(c.now).getTime())).toBe(true);
      expect(Array.isArray(c.expect.include)).toBe(true);
      expect(Array.isArray(c.setup)).toBe(true);
      expect(c.setup.length).toBeGreaterThan(0);
    }
  });

  it('should generate deterministic scale benchmark dataset with requested count', () => {
    const s1 = generateScaleDataset(250, 777);
    const s2 = generateScaleDataset(250, 777);

    expect(s1.memories.length).toBe(250);
    expect(s1.queries.length).toBeGreaterThanOrEqual(12);
    expect(JSON.stringify(s1)).toBe(JSON.stringify(s2));

    const queryIds = new Set(s1.queries.map((q) => q.id));
    expect(queryIds.size).toBe(s1.queries.length);
  });
});
