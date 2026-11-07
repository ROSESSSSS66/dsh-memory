import * as React from 'react';
import { MemoryApp } from './MemoryApp.js';

function BrainIcon({ size = 16 }: { size?: number }) {
  return React.createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: '1.8',
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    },
    React.createElement('path', {
      d: 'M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-2.04z',
    }),
    React.createElement('path', {
      d: 'M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-2.04z',
    })
  );
}

export const name = 'dsh-memory';
export const inject = ['slots'];

export function apply(ctx: any) {
  const SIDEBAR_PANEL_ID = 'dsh-memory';
  const SIDEBAR_PANEL_ORDER = 15;

  ctx.slots?.inject?.('main', () => {
    return ctx.slots.register(
      {
        name: 'main',
        key: SIDEBAR_PANEL_ID,
        locale: 'dsh-memory',
      },
      () => React.createElement(MemoryApp)
    );
  });

  ctx.slots?.inject?.('sidebar.panellist', () => {
    return ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: SIDEBAR_PANEL_ID,
        order: SIDEBAR_PANEL_ORDER,
        label: () => '长期记忆',
        locale: 'dsh-memory',
      },
      (ownerProps: any) =>
        React.createElement(BrainIcon, {
          size: ownerProps && typeof ownerProps.size === 'number' ? ownerProps.size : 16,
        })
    );
  });
}

export default {
  name,
  inject,
  apply,
};
