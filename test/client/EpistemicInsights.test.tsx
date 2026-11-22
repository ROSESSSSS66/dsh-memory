// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EpistemicInsights } from '../../src/client/components/EpistemicInsights.js';
import type {
  HindsightSummaryData,
  VikingSummaryData,
} from '../../src/client/types.js';

function createHindsightWithMentalModels(): HindsightSummaryData {
  return {
    networkCounts: {
      world: 11,
      experience: 7,
      observation: 5,
      opinion: 3,
    },
    mentalModels: [
      {
        id: 'mm_1',
        slot_key: 'model.testing.vitest',
        summary: 'Prefer isolated temporary SQLite databases for unit tests.',
        confidence: 0.93,
        network: 'observation',
        updated_at: Date.now() - 120_000,
        vikingUri: 'viking://memories/models/testing-vitest',
      },
    ],
  };
}

function createVikingSummary(): VikingSummaryData {
  return {
    rootUri: 'viking://memories',
    totalMemories: 26,
    categories: [
      {
        category: 'profile',
        uri: 'viking://memories/profile',
        count: 3,
        sampleAbstracts: [
          'Maintains TypeScript NodeNext backend services',
          'Prefers strict zero-any type hygiene',
        ],
      },
      {
        category: 'cases',
        uri: 'viking://memories/cases',
        count: 5,
        description: 'SQLite FTS5 self-healing recovery notes',
      },
      {
        category: 'skills',
        uri: 'viking://memories/skills',
        count: 2,
      },
    ],
  };
}

afterEach(() => {
  cleanup();
});

describe('EpistemicInsights', () => {
  it('renders read-only collapsible <details> panel with zero action buttons, 4 Hindsight networks, mentalModels, and OpenViking categories in en', () => {
    const { container } = render(
      <EpistemicInsights
        hindsight={createHindsightWithMentalModels()}
        viking={createVikingSummary()}
        locale="en"
      />
    );

    // Collapsible <details> panel and zero extra action buttons
    const rootDetails = container.querySelector(
      'details.dshm-insights-details'
    );
    expect(rootDetails).not.toBeNull();
    expect(container.querySelectorAll('button').length).toBe(0);

    // Summary counts header
    expect(
      screen.getByText('Epistemic Insights · Hindsight & OpenViking')
    ).toBeTruthy();
    expect(screen.getByText('1 mental models · 26 indexed')).toBeTruthy();

    // All 4 Hindsight networks with counts
    const cards = Array.from(container.querySelectorAll('.dshm-network-card'));
    expect(cards.length).toBe(4);
    expect(cards.map((c) => c.textContent)).toEqual([
      'WORLD11',
      'EXPERIENCE7',
      'OBSERVATION5',
      'OPINION3',
    ]);

    // Mental model rendered from mentalModels shape
    expect(
      screen.getByText(
        'Prefer isolated temporary SQLite databases for unit tests.'
      )
    ).toBeTruthy();
    expect(screen.getByText('Conf 93%')).toBeTruthy();
    expect(
      screen.getByText('viking://memories/models/testing-vitest')
    ).toBeTruthy();

    // OpenViking categories: profile (sampleAbstracts), cases (description fallback), skills (static without samples)
    expect(screen.getByText('Profile')).toBeTruthy();
    expect(screen.getByText('viking://memories/profile')).toBeTruthy();
    expect(
      screen.getByText('Maintains TypeScript NodeNext backend services')
    ).toBeTruthy();
    expect(
      screen.getByText('Prefers strict zero-any type hygiene')
    ).toBeTruthy();

    expect(screen.getByText('Cases')).toBeTruthy();
    expect(
      screen.getByText('SQLite FTS5 self-healing recovery notes')
    ).toBeTruthy();

    expect(screen.getByText('Skills')).toBeTruthy();
    expect(
      container.querySelectorAll('.dshm-viking-cat-static').length
    ).toBe(1);
    expect(
      container.querySelectorAll('details.dshm-viking-cat').length
    ).toBe(2);

    // Zero hardcoded Chinese characters in English locale
    expect(container.textContent ?? '').not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('supports legacy existingModels shape with slotKey and type fallback', () => {
    const legacyHindsight: HindsightSummaryData = {
      networkCounts: {
        world: 2,
        experience: 1,
        observation: 4,
        opinion: 0,
      },
      existingModels: [
        {
          id: 'legacy_mm_1',
          slotKey: 'legacy.slot.key',
          summary: 'Synthesized from existingModels field.',
          confidence: 0.84,
          type: 'belief',
        },
      ],
    };

    render(
      <EpistemicInsights
        hindsight={legacyHindsight}
        viking={null}
        locale="en"
      />
    );

    expect(screen.getByText('1 mental models · 0 indexed')).toBeTruthy();
    expect(
      screen.getByText('Synthesized from existingModels field.')
    ).toBeTruthy();
    expect(screen.getByText('belief')).toBeTruthy();
    expect(screen.getByText('legacy.slot.key')).toBeTruthy();
    expect(screen.getByText('Conf 84%')).toBeTruthy();
  });

  it('renders localized Chinese labels cleanly including profile category', () => {
    const { container } = render(
      <EpistemicInsights
        hindsight={createHindsightWithMentalModels()}
        viking={createVikingSummary()}
        locale="zh"
      />
    );

    expect(container.querySelectorAll('button').length).toBe(0);
    expect(
      screen.getByText('认知洞察 · Hindsight & OpenViking')
    ).toBeTruthy();
    expect(screen.getByText('1 心智模型 · 26 目录节点')).toBeTruthy();
    expect(screen.getByText('Hindsight 四维记忆网络')).toBeTruthy();
    expect(screen.getByText('WORLD · 事实')).toBeTruthy();
    expect(screen.getByText('EXPERIENCE · 经验')).toBeTruthy();
    expect(screen.getByText('OBSERVATION · 观察')).toBeTruthy();
    expect(screen.getByText('OPINION · 观点')).toBeTruthy();
    expect(screen.getByText('综合心智模型')).toBeTruthy();
    expect(screen.getByText('置信 93%')).toBeTruthy();
    expect(screen.getByText('OpenViking L0/L1 上下文目录')).toBeTruthy();
    expect(screen.getByText('用户画像')).toBeTruthy();
    expect(screen.getByText('排错案例')).toBeTruthy();
    expect(screen.getByText('流程技能')).toBeTruthy();
  });

  it('handles empty and null states gracefully in both en and zh', () => {
    // Both null -> renders nothing
    const nullRender = render(
      <EpistemicInsights hindsight={null} viking={null} locale="en" />
    );
    expect(nullRender.container.innerHTML).toBe('');
    nullRender.unmount();

    // Empty arrays -> localized empty placeholders
    const emptyHindsight: HindsightSummaryData = {
      networkCounts: { world: 0, experience: 0, observation: 0, opinion: 0 },
      mentalModels: [],
    };
    const emptyViking: VikingSummaryData = {
      rootUri: 'viking://memories',
      totalMemories: 0,
      categories: [],
    };

    const enEmpty = render(
      <EpistemicInsights
        hindsight={emptyHindsight}
        viking={emptyViking}
        locale="en"
      />
    );
    expect(
      screen.getByText(
        'No mental models yet. Synthesized automatically during slow-loop reflection.'
      )
    ).toBeTruthy();
    expect(screen.getByText('No indexed nodes yet.')).toBeTruthy();
    enEmpty.unmount();

    render(
      <EpistemicInsights
        hindsight={emptyHindsight}
        viking={emptyViking}
        locale="zh"
      />
    );
    expect(
      screen.getByText('尚未沉淀心智模型，后台慢环反思后将自动生成。')
    ).toBeTruthy();
    expect(screen.getByText('目录暂无索引节点。')).toBeTruthy();
  });
});
