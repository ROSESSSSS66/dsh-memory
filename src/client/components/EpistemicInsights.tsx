import { formatRelativeTime, getMessages } from '../i18n.js';
import type {
  HindsightSummaryData,
  UiLocale,
  VikingSummaryData,
} from '../types.js';

export interface EpistemicInsightsProps {
  hindsight: HindsightSummaryData | null;
  viking: VikingSummaryData | null;
  locale: UiLocale;
}

export function EpistemicInsights({
  hindsight,
  viking,
  locale,
}: EpistemicInsightsProps) {
  if (!hindsight && !viking) return null;

  const t = getMessages(locale);

  const counts = hindsight?.networkCounts ?? {
    world: 0,
    experience: 0,
    observation: 0,
    opinion: 0,
  };
  const totalNetworkItems = Math.max(
    1,
    counts.world + counts.experience + counts.observation + counts.opinion
  );

  const networkEntries: Array<{
    key: 'world' | 'experience' | 'observation' | 'opinion';
    label: string;
    count: number;
  }> = [
    { key: 'world', label: t.epistemic.networks.world, count: counts.world },
    {
      key: 'experience',
      label: t.epistemic.networks.experience,
      count: counts.experience,
    },
    {
      key: 'observation',
      label: t.epistemic.networks.observation,
      count: counts.observation,
    },
    {
      key: 'opinion',
      label: t.epistemic.networks.opinion,
      count: counts.opinion,
    },
  ];

  const models = hindsight?.mentalModels ?? hindsight?.existingModels ?? [];
  const categories = viking?.categories ?? [];
  const vikingTotal = viking?.totalMemories ?? 0;

  return (
    <section className="dshm-section" aria-label={t.epistemic.ariaLabel}>
      <details className="dshm-insights-details">
        <summary className="dshm-insights-summary">
          <div className="dshm-insights-summary-left">
            <span className="dshm-section-label">{t.epistemic.title}</span>
          </div>
          <div className="dshm-insights-summary-right">
            <span>{t.epistemic.summaryCounts(models.length, vikingTotal)}</span>
            <span className="dshm-process-chevron" aria-hidden="true">
              ›
            </span>
          </div>
        </summary>

        <div className="dshm-insights-body">
          {/* 1. Hindsight 4-Network Bank + Synthesized Mental Models */}
          {hindsight ? (
            <div className="dshm-insights-block">
              <div className="dshm-insights-block-head">
                <span className="dshm-insights-block-title">
                  {t.epistemic.hindsightTitle}
                </span>
              </div>

              <div className="dshm-network-grid">
                {networkEntries.map((item) => {
                  const pct = Math.min(100, (item.count / totalNetworkItems) * 100);
                  return (
                    <div key={item.key} className="dshm-network-card">
                      <span className="dshm-network-label">{item.label}</span>
                      <span className="dshm-network-count">{item.count}</span>
                      <div className="dshm-network-bar" aria-hidden="true">
                        <div
                          className="dshm-network-bar-fill"
                          style={{ width: `${item.count > 0 ? Math.max(4, pct) : 0}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="dshm-insights-block-head">
                <span className="dshm-insights-block-title">
                  {t.epistemic.mentalModelsTitle}
                </span>
              </div>

              {models.length === 0 ? (
                <div className="dshm-insights-empty">
                  {t.epistemic.mentalModelsEmpty}
                </div>
              ) : (
                <div className="dshm-model-list">
                  {models.map((model) => {
                    const badge = model.network || model.type || 'model';
                    const slotLabel = model.slot_key ?? model.slotKey ?? '';
                    return (
                      <div key={model.id} className="dshm-model-item">
                        <div className="dshm-model-head">
                          <span className="dshm-model-badge">{badge}</span>
                          <div className="dshm-model-meta">
                            <span>
                              {t.epistemic.confidence(
                                Math.round((model.confidence ?? 0.8) * 100)
                              )}
                            </span>
                            {model.updated_at ? (
                              <span>
                                {formatRelativeTime(model.updated_at, locale)}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <div className="dshm-model-summary">{model.summary}</div>
                        {model.vikingUri || slotLabel ? (
                          <div className="dshm-model-uri">
                            {model.vikingUri || slotLabel}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}

          {/* 2. OpenViking L0/L1 Context Tree */}
          {viking ? (
            <div className="dshm-insights-block">
              <div className="dshm-insights-block-head">
                <span className="dshm-insights-block-title">
                  {t.epistemic.vikingTitle}
                </span>
                <span className="dshm-insights-uri">
                  {viking.rootUri} · {t.epistemic.vikingTotal(vikingTotal)}
                </span>
              </div>

              {categories.length === 0 ? (
                <div className="dshm-insights-empty">{t.epistemic.vikingEmpty}</div>
              ) : (
                <div className="dshm-viking-tree">
                  {categories.map((cat) => {
                    const catLabel =
                      t.epistemic.vikingCategories[cat.category] || cat.category;
                    const samples =
                      Array.isArray(cat.sampleAbstracts) &&
                      cat.sampleAbstracts.length > 0
                        ? cat.sampleAbstracts
                        : cat.description
                          ? [cat.description]
                          : [];
                    const hasSamples = samples.length > 0;

                    if (!hasSamples) {
                      return (
                        <div key={cat.category} className="dshm-viking-cat">
                          <div className="dshm-viking-cat-static">
                            <div className="dshm-viking-cat-left">
                              <span className="dshm-viking-cat-name">{catLabel}</span>
                              <span className="dshm-viking-cat-uri">{cat.uri}</span>
                            </div>
                            <span className="dshm-viking-cat-count">{cat.count}</span>
                          </div>
                        </div>
                      );
                    }

                    return (
                      <details key={cat.category} className="dshm-viking-cat">
                        <summary className="dshm-viking-cat-summary">
                          <div className="dshm-viking-cat-left">
                            <span className="dshm-viking-cat-name">{catLabel}</span>
                            <span className="dshm-viking-cat-uri">{cat.uri}</span>
                          </div>
                          <span className="dshm-viking-cat-count">
                            <span>{cat.count}</span>
                            <span className="dshm-process-chevron" aria-hidden="true">
                              ›
                            </span>
                          </span>
                        </summary>
                        <ul className="dshm-viking-samples">
                          {samples.map((sample) => (
                            <li key={`${cat.uri}:${sample}`} className="dshm-viking-sample">
                              {sample}
                            </li>
                          ))}
                        </ul>
                      </details>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}
        </div>
      </details>
    </section>
  );
}
