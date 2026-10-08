import type { MenuSnapshot } from '@slush/core';
import { useEffect, useState } from 'react';
import { getApi } from './api';
import { load, save } from './storage';

export interface MenuState {
  menu: MenuSnapshot | null;
  /** Showing the copy saved on this phone because the network failed (Phase 6 C11). */
  offline: boolean;
  error: boolean;
}

let memory: MenuSnapshot | null = null;

/**
 * Show the last menu instantly (from memory or this phone), then refresh it.
 * A slightly old menu is harmless: checkout re-prices everything on the server (FR-14).
 */
export function useMenu(branchSlug: string): MenuState {
  const cacheKey = `slush-menu:${branchSlug}`;
  const [state, setState] = useState<MenuState>(() => {
    const cached = memory ?? load<MenuSnapshot | null>(cacheKey, null);
    return { menu: cached, offline: false, error: false };
  });

  useEffect(() => {
    let alive = true;
    void getApi()
      .then((api) => api.menu(branchSlug))
      .then(
        (menu) => {
          memory = menu;
          save(cacheKey, menu);
          if (alive) setState({ menu, offline: false, error: false });
        },
        () => alive && setState((s) => ({ menu: s.menu, offline: Boolean(s.menu), error: !s.menu })),
      );
    return () => {
      alive = false;
    };
  }, [branchSlug, cacheKey]);

  return state;
}
