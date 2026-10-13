import type { OwnedSubscription, PaseoAgent, PaseoAgentListResult, PaseoApi } from '@getpaseo/client';
import type { ResearchCard } from '../shared/research';

type AgentState = Pick<PaseoAgent, 'id' | 'provider' | 'status' | 'pendingPermissions'>;

export function hasResearchPermission(agent: AgentState | undefined, requestId: string | undefined): boolean {
  return !!requestId && agent?.provider === 'gemini-web' && agent.status !== 'closed' &&
    agent.pendingPermissions.some(request => request.id === requestId && request.name === 'deep_research' &&
      request.kind === 'plan' && request.provider === 'gemini-web');
}

export function isGeminiResearchUrl(url: string | undefined): url is string {
  return typeof url === 'string' && /^https:\/\/gemini\.google\.com\/app(?:\/[a-zA-Z0-9_-]+)?$/.test(url);
}

/** Owns live permission snapshots and deduplicates actions across panes showing the same card. */
export class ResearchCardState {
  private readonly lifetime = new AbortController();
  private readonly agents = new Map<string, AgentState>();
  private readonly busy = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private subscription?: OwnedSubscription<PaseoAgentListResult>;
  private unsubscribe?: () => void;
  private revision = 0;
  private ready = false;
  private failure?: string;

  constructor(private readonly paseo: Pick<PaseoApi, 'agents'>) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly snapshot = () => this.revision;
  private changed() { this.revision++; for (const listener of this.listeners) listener(); }

  start(): void {
    void this.paseo.agents.list({ subscribe: {}, signal: this.lifetime.signal }).then(({ subscription }) => {
      if (this.lifetime.signal.aborted) { void subscription.release().catch(() => {}); return; }
      this.subscription = subscription;
      this.unsubscribe = subscription.subscribe({
        snapshot: ({ entries }) => {
          if (this.lifetime.signal.aborted) return;
          this.agents.clear();
          for (const { agent } of entries) if (agent.provider === 'gemini-web') this.agents.set(agent.id, agent);
          this.ready = true; this.failure = undefined; this.changed();
        },
        update: message => {
          if (this.lifetime.signal.aborted || message.type !== 'agent_update') return;
          const update = message.payload;
          if (update.kind === 'upsert') {
            if (update.agent.provider === 'gemini-web') this.agents.set(update.agent.id, update.agent);
            else this.agents.delete(update.agent.id);
          } else this.agents.delete(update.agentId);
          this.changed();
        },
        error: () => this.unavailable(),
      });
    }).catch(() => { if (!this.lifetime.signal.aborted) this.unavailable(); });
  }

  private unavailable() {
    if (this.lifetime.signal.aborted) return;
    this.agents.clear(); this.ready = false;
    this.failure = '승인 상태를 확인할 수 없습니다. Paseo 연결을 확인해 주세요.';
    this.changed();
  }

  canRespond(agentId: string, card: ResearchCard): boolean {
    return !this.lifetime.signal.aborted && card.phase === 'plan' &&
      hasResearchPermission(this.agents.get(agentId), card.permissionId);
  }

  isBusy(agentId: string, permissionId: string | undefined): boolean {
    return !!permissionId && this.busy.has(`${agentId}:${permissionId}`);
  }

  unavailableMessage(): string {
    return this.failure ?? (this.ready ? '이 계획은 현재 승인 대기 상태가 아닙니다.' : '현재 승인 상태를 확인하는 중…');
  }

  async respond(agentId: string, card: ResearchCard, behavior: 'allow' | 'deny'): Promise<void> {
    if (!this.canRespond(agentId, card) || !card.permissionId) throw new Error('이 조사 계획의 승인 요청이 더 이상 유효하지 않습니다.');
    const requestId = card.permissionId;
    const key = `${agentId}:${requestId}`;
    if (this.busy.has(key)) return;
    this.busy.add(key); this.changed();
    try {
      const agent = this.paseo.agents.ref(agentId);
      // Recheck on the daemon immediately before responding: cached historical cards
      // and a disconnected/reconnected client must never approve a different plan.
      const refreshed = await agent.refresh();
      if (this.lifetime.signal.aborted) return;
      if (refreshed) this.agents.set(agentId, refreshed.agent); else this.agents.delete(agentId);
      this.changed();
      if (!this.canRespond(agentId, card)) throw new Error('이 조사 계획의 승인 요청이 이미 처리되었거나 만료되었습니다.');
      await agent.respondToPermission({ requestId, response: behavior === 'allow'
        ? { behavior: 'allow', selectedActionId: 'allow' }
        : { behavior: 'deny', selectedActionId: 'deny', interrupt: true, message: '사용자가 조사 계획을 취소했습니다.' } });
      if (!this.lifetime.signal.aborted) {
        const current = this.agents.get(agentId);
        if (current) this.agents.set(agentId, { ...current, pendingPermissions: current.pendingPermissions.filter(request => request.id !== requestId) });
      }
    } finally {
      this.busy.delete(key);
      if (!this.lifetime.signal.aborted) this.changed();
    }
  }

  close(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort(); this.unsubscribe?.();
    void this.subscription?.release().catch(() => {});
    this.agents.clear(); this.busy.clear(); this.listeners.clear();
  }
}
