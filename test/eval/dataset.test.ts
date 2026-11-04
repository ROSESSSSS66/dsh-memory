import { describe, it, expect } from 'vitest';
import { generateDataset, createSeededRandom } from '../../src/eval/gen-dataset.js';

describe('Evaluation Dataset Generator (§8.2)', () => {
  it('should generate 120 deterministic evaluation cases', () => {
    const ds1 = generateDataset(12345);
    const ds2 = generateDataset(12345);

    expect(ds1.length).toBe(120);
    expect(ds2.length).toBe(120);
    expect(JSON.stringify(ds1)).toBe(JSON.stringify(ds2));
  });

  it('should cover all 4 suites with 30 cases each', () => {
    const ds = generateDataset();
    const suiteCounts: Record<string, number> = {};
    for (const c of ds) {
      suiteCounts[c.suite] = (suiteCounts[c.suite] || 0) + 1;
    }

    expect(suiteCounts['factual']).toBe(30);
    expect(suiteCounts['temporal']).toBe(30);
    expect(suiteCounts['procedural']).toBe(30);
    expect(suiteCounts['implicit']).toBe(30);
  });

  it('should contain >= 20 critical cases', () => {
    const ds = generateDataset();
    const criticalCount = ds.filter(c => c.critical).length;
    expect(criticalCount).toBeGreaterThanOrEqual(20);
  });

  it('should contain >= 10 empty-threshold cases', () => {
    const ds = generateDataset();
    const emptyCount = ds.filter(c => c.expect.include.length === 0).length;
    expect(emptyCount).toBeGreaterThanOrEqual(10);
  });

  it('each case should have valid structure, non-empty query and setup', () => {
    const ds = generateDataset();
    for (const c of ds) {
      expect(c.id).toBeDefined();
      expect(c.suite).toBeDefined();
      expect(c.query).toBeDefined();
      expect(c.query.length).toBeGreaterThan(0);
      expect(c.workspace).toBeDefined();
      expect(c.now).toBeDefined();
      expect(c.expect).toBeDefined();
      expect(Array.isArray(c.expect.include)).toBe(true);
      expect(Array.isArray(c.setup)).toBe(true);
    }
  });
});
