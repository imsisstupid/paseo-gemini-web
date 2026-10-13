import { openExternalUrl, type PluginClientContext, type PluginTimelineItemProps } from '@getpaseo/plugin/client';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Pressable, Text, View } from 'react-native';
import { researchCardSchema, type ResearchCard } from '../shared/research';
import { isGeminiResearchUrl, ResearchCardState } from './research-card-state';

const phaseLabels: Record<ResearchCard['phase'], string> = {
  preparing: '조사 계획 준비 중', plan: '조사 계획 확인', researching: '조사 진행 중',
  completed: '조사 완료', canceled: '조사 취소됨', failed: '조사 연결 오류',
};
// User-selected research branding stays blue across Paseo themes.
const researchBlue = '#1e3a8a';
const researchWhite = '#ffffff';

function ResearchCardView({ agentId, item, theme, layout, state }: PluginTimelineItemProps<ResearchCard> & { state: ResearchCardState }) {
  const card = item.data;
  useSyncExternalStore(state.subscribe, state.snapshot, state.snapshot);
  const [error, setError] = useState<string>();
  const actionVersion = useRef(0);
  useEffect(() => { actionVersion.current++; setError(undefined); return () => { actionVersion.current++; }; }, [agentId, card.permissionId, card.phase]);
  const permitted = state.canRespond(agentId, card);
  const busy = state.isBusy(agentId, card.permissionId);
  const disabled = !permitted || busy;
  const colors = theme.colors;
  const text = { color: colors.foreground, fontSize: 14, lineHeight: 22 };
  const secondary = { ...text, color: colors.foregroundMuted };

  async function respond(behavior: 'allow' | 'deny') {
    const version = actionVersion.current;
    setError(undefined);
    try { await state.respond(agentId, card, behavior); }
    catch (failure) {
      if (version === actionVersion.current) setError(failure instanceof Error ? failure.message : '승인 요청을 처리하지 못했습니다. 다시 시도해 주세요.');
    }
  }

  async function openOriginal() {
    if (!isGeminiResearchUrl(card.url)) return;
    const version = actionVersion.current;
    setError(undefined);
    try { await openExternalUrl(card.url); }
    catch { if (version === actionVersion.current) setError('Gemini 원문을 열지 못했습니다.'); }
  }

  return (
    <View testID={`gemini-research-card-${agentId}`} style={{ padding: layout.compact ? 14 : 18, gap: 12, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1 }}>
      <View style={{ gap: 4 }}>
        <Text testID={`gemini-research-heading-${agentId}`} style={{ ...text, color: researchWhite, backgroundColor: researchBlue, alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, fontWeight: '600' }}>Deep Research · {phaseLabels[card.phase]}</Text>
        <Text accessibilityLiveRegion="polite" style={secondary}>{card.status}</Text>
      </View>
      {card.plan ? <Text selectable style={text}>{card.plan}</Text> : null}
      {card.phase === 'plan' ? (
        <View style={{ gap: 10 }}>
          <Text style={secondary}>계획을 바꾸려면 취소 후 변경 내용을 메시지로 보내세요.</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Pressable testID={`gemini-research-start-${card.permissionId}`} accessibilityRole="button" accessibilityLabel="연구 시작" accessibilityState={{ disabled, busy }} disabled={disabled}
              onPress={() => { void respond('allow'); }} style={({ pressed }) => ({ paddingHorizontal: 15, paddingVertical: 10, borderRadius: 9, backgroundColor: researchBlue, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 })}>
              <Text style={{ ...text, color: researchWhite, fontWeight: '600' }}>{busy ? '처리 중…' : '연구 시작'}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="조사 계획 취소" accessibilityState={{ disabled, busy }} disabled={disabled}
              onPress={() => { void respond('deny'); }} style={({ pressed }) => ({ paddingHorizontal: 15, paddingVertical: 10, borderRadius: 9, backgroundColor: colors.surface2, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 })}>
              <Text style={text}>취소</Text>
            </Pressable>
          </View>
          {!permitted && !busy ? <Text style={secondary}>{state.unavailableMessage()}</Text> : null}
        </View>
      ) : null}
      {card.phase === 'completed' ? <Text style={secondary}>완료된 보고서는 아래 답변에서 확인할 수 있습니다.</Text> : null}
      {isGeminiResearchUrl(card.url) ? (
        <Pressable testID={`gemini-research-link-${agentId}`} accessibilityRole="link" accessibilityLabel="Gemini 원문 열기" onPress={() => { void openOriginal(); }}
          style={({ pressed }) => ({ alignSelf: 'flex-start', paddingHorizontal: 11, paddingVertical: 6, borderRadius: 8, backgroundColor: researchBlue, opacity: pressed ? 0.8 : 1 })}>
          <Text style={{ ...text, color: researchWhite }}>Gemini 원문 열기 ↗</Text>
        </Pressable>
      ) : null}
      {error ? <Text accessibilityRole="alert" style={{ ...text, color: colors.statusDanger }}>{error}</Text> : null}
    </View>
  );
}

export function contributeResearchCards(client: PluginClientContext) {
  const state = new ResearchCardState(client.paseo);
  const remove = client.addTimelineRenderer({ kind: 'deep-research', version: 1, schema: researchCardSchema,
    Component: props => <ResearchCardView {...props} state={state} /> });
  state.start();
  return () => { state.close(); remove(); };
}
