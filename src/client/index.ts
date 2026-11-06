import * as React from 'react';
import { MemoryApp } from './MemoryApp.js';
import { BrainIcon } from './components/Icons.js';

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
