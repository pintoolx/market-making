const RETURN_KEY = 'pintool:strategy-return';

export function strategyHref(id: string, ens?: string) {
  const query = new URLSearchParams({ id });
  if (ens) query.set('ens', ens);
  return `/strategy?${query}`;
}

export function rememberMarketplace() {
  if (window.location.pathname !== '/maker') return;
  try {
    sessionStorage.setItem(RETURN_KEY, JSON.stringify({
      url: window.location.pathname + window.location.search,
      scroll: document.querySelector('[data-marketplace-scroll]')?.scrollTop ?? 0,
      restore: true,
    }));
  } catch { /* Navigation works without session storage. */ }
}

export function consumeMarketplaceReturn() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(RETURN_KEY) || 'null');
    if (saved?.restore && saved.url === window.location.pathname + window.location.search) {
      sessionStorage.setItem(RETURN_KEY, JSON.stringify({ ...saved, restore: false }));
      return true;
    }
  } catch { /* A missing return marker uses the normal Maker landing flow. */ }
  return false;
}

export function marketplaceReturn() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(RETURN_KEY) || 'null');
    if (saved && /^\/maker(?:\?|$)/.test(saved.url) && Number.isFinite(saved.scroll) && saved.scroll >= 0) return saved as { url: string; scroll: number };
  } catch { /* Direct links return to the marketplace. */ }
  return { url: '/maker', scroll: 0 };
}

export function restoreMarketplaceScroll() {
  const saved = marketplaceReturn();
  if (saved.url !== window.location.pathname + window.location.search) return;
  document.querySelector('[data-marketplace-scroll]')?.scrollTo({ top: saved.scroll });
}
