import { describe, expect, test } from 'bun:test';
import { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse as parseYaml } from 'yaml';
import { parseRoutingStrategy, useVisualConfig } from '../src/hooks/useVisualConfig';
import { normalizeRoutingStrategy } from '../src/services/api/routing';
import { ROUTING_STRATEGIES } from '../src/types/routing';

describe('visual config weighted routing strategy', () => {
  test('recognizes the weighted-round-robin backend value', () => {
    expect(parseRoutingStrategy('weighted-round-robin')).toBe('weighted-round-robin');
    expect(parseRoutingStrategy('weightedroundrobin')).toBe('weighted-round-robin');
    expect(parseRoutingStrategy('wrr')).toBe('weighted-round-robin');
    expect(parseRoutingStrategy('fill-first')).toBe('fill-first');
    expect(parseRoutingStrategy('fillfirst')).toBe('fill-first');
    expect(parseRoutingStrategy('ff')).toBe('fill-first');
    expect(parseRoutingStrategy(undefined)).toBe('round-robin');
  });

  test('writes weighted-round-robin without coercing it to round-robin', () => {
    function Harness() {
      const visualConfig = useVisualConfig();
      const [phase, setPhase] = useState(0);

      if (phase === 0) {
        visualConfig.setVisualValues({ routingStrategy: 'weighted-round-robin' });
        setPhase(1);
      } else {
        return createElement(
          'pre',
          null,
          visualConfig.applyVisualChangesToYaml('routing:\n  strategy: round-robin\n')
        );
      }

      return null;
    }

    const markup = renderToStaticMarkup(createElement(Harness));
    const result = markup.slice('<pre>'.length, -'</pre>'.length);

    expect(parseYaml(result)).toEqual({ routing: { strategy: 'weighted-round-robin' } });
  });
});

describe('soonest-reset routing strategy', () => {
  test('parses in both the config panel and the routing board', () => {
    for (const raw of ['soonest-reset', 'soonestreset', 'SOONEST_RESET']) {
      expect(parseRoutingStrategy(raw)).toBe('soonest-reset');
      expect(normalizeRoutingStrategy(raw)).toBe('soonest-reset');
    }
    expect(ROUTING_STRATEGIES).toContain('soonest-reset');
  });

  test('writes soonest-reset back to YAML unchanged', () => {
    function Harness() {
      const visualConfig = useVisualConfig();
      const [phase, setPhase] = useState(0);
      if (phase === 0) {
        visualConfig.setVisualValues({ routingStrategy: 'soonest-reset' });
        setPhase(1);
        return null;
      }
      return createElement(
        'pre',
        null,
        visualConfig.applyVisualChangesToYaml('routing:\n  strategy: round-robin\n')
      );
    }

    const markup = renderToStaticMarkup(createElement(Harness));
    const result = markup.slice('<pre>'.length, -'</pre>'.length);
    expect(parseYaml(result)).toEqual({ routing: { strategy: 'soonest-reset' } });
  });
});
