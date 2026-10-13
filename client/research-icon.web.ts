import { Platform } from 'react-native';
import { RESEARCH_ENABLED_LABEL, RESEARCH_FEATURE_ID } from '../shared/research-state';

interface ResearchStyleElement {
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  remove(): void;
}
declare const document: {
  head?: { appendChild(style: ResearchStyleElement): unknown };
  createElement(tag: 'style'): ResearchStyleElement;
};

/**
 * Paseo 0.11's native toggle has no custom active-color setting. Scope this
 * reversible desktop/web compatibility style to the exact feature and its
 * committed ON label. The host still owns clicks, OFF styling, and state.
 * This intentionally depends on the 0.11 control's DOM attributes.
 */
export function startResearchIconStyles(): () => void {
  if (Platform.OS !== 'web' || typeof document === 'undefined' || !document.head) return () => {};
  const selector = `[data-testid="agent-feature-${RESEARCH_FEATURE_ID}"][aria-label="${RESEARCH_ENABLED_LABEL}"]`;
  const style = document.createElement('style');
  style.setAttribute('data-paseo-gemini-research-icon', '0.11');
  style.textContent = `${selector} svg, ${selector} svg * { color: #3b82f6 !important; stroke: #3b82f6 !important; }`;
  document.head.appendChild(style);
  // Each installation owns its element; removing one cannot remove another's.
  return () => style.remove();
}
