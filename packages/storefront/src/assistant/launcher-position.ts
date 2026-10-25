/** Keep the launcher clear of visible floating controls without moving the other widgets. */
const GAP = 12;
const OWN_UI = '.tryora-assistant, .tryora, .tryora-assistant-launch';
const KNOWN_WIDGETS = '#shopify-chat, inbox-online-store-chat, #ShopifyChat, .shopify-chat-button, #tidio-chat, #gorgias-chat-container';

export function avoidFloatingWidgets(button: HTMLElement): () => void {
  if (typeof window.addEventListener !== 'function' || typeof button.getBoundingClientRect !== 'function') return () => {};
  let candidates: Element[] = [];
  let offset = 0;
  let stopped = false;
  let pending: ReturnType<typeof setTimeout> | undefined;
  const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver((records) => {
    if (records.some((record) => !(record.target instanceof Element) || !record.target.closest(OWN_UI))) schedule(true);
  });
  let rescan = true;
  const scan = () => {
    candidates = [];
    const roots = new Set<Node>();
    const visit = (root: Document | ShadowRoot) => {
      roots.add(root);
      for (const element of root.querySelectorAll('*')) {
        if (element === button || element.closest(OWN_UI)) continue;
        const style = getComputedStyle(element);
        if (style.position === 'fixed' || style.position === 'sticky' || element.matches(KNOWN_WIDGETS)) candidates.push(element);
        if (element.shadowRoot) visit(element.shadowRoot);
      }
    };
    visit(document);
    // Reconnect to release detached shadow roots as widgets appear/disappear.
    observer?.disconnect();
    for (const root of roots) {
      observer?.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'open'] });
    }
  };
  const update = () => {
    if (stopped) return;
    if (!button.isConnected) { stop(); return; }
    if (rescan) { scan(); rescan = false; }
    const rect = button.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const viewport = window.visualViewport;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportBottom = Math.min(window.innerHeight, viewport ? viewport.offsetTop + viewport.height : window.innerHeight);
    // Read the CSS base (including preview stacking and safe-area) independently of our last offset.
    const bottom = parseFloat(getComputedStyle(button).bottom) - offset;
    if (!Number.isFinite(bottom)) return;
    const baseBottom = window.innerHeight - bottom;
    let nextBottom = Math.min(baseBottom, viewportBottom - 14);
    const obstacles = candidates.flatMap((element) => {
      if (!element.isConnected || element.closest(OWN_UI)) return [];
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return [];
      if (typeof element.checkVisibility === 'function' && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return [];
      const box = element.getBoundingClientRect();
      // Full-screen backdrops and large open dialogs are not small corner obstructions.
      if (!box.width || !box.height || box.height > (viewportBottom - viewportTop) * .6 || box.bottom <= viewportTop || box.top >= viewportBottom) return [];
      if (box.right <= rect.left - GAP || box.left >= rect.right + GAP) return [];
      if (style.position === 'sticky' && (style.bottom === 'auto' || box.bottom < viewportBottom - parseFloat(style.bottom) - 2)) return [];
      return [box];
    }).sort((a, b) => b.top - a.top);
    for (const box of obstacles) {
      if (nextBottom > box.top - GAP && nextBottom - rect.height < box.bottom + GAP) nextBottom = box.top - GAP;
    }
    nextBottom = Math.max(viewportTop + rect.height + 8, nextBottom);
    const next = Math.max(0, Math.ceil(baseBottom - nextBottom));
    if (next !== offset) {
      offset = next;
      button.style.setProperty('--ta-avoid', offset + 'px');
    }
  };
  function schedule(rebuild = false) {
    rescan ||= rebuild;
    if (!stopped && pending === undefined) pending = setTimeout(() => { pending = undefined; update(); }, 80);
  }
  const onLayout = () => schedule();
  const onResize = () => schedule(true);
  // Also follows CSS animations, late iframe resizing and widgets hidden without DOM removal.
  const timer = setInterval(() => { schedule(); }, 500);
  function stop() {
    if (stopped) return;
    stopped = true; clearInterval(timer); clearTimeout(pending); observer?.disconnect();
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', onLayout, true);
    window.visualViewport?.removeEventListener('resize', onResize);
    window.visualViewport?.removeEventListener('scroll', onLayout);
    button.style.removeProperty('--ta-avoid');
  }
  window.addEventListener('resize', onResize);
  window.addEventListener('scroll', onLayout, { passive: true, capture: true });
  window.visualViewport?.addEventListener('resize', onResize);
  window.visualViewport?.addEventListener('scroll', onLayout);
  schedule(true);
  return stop;
}
