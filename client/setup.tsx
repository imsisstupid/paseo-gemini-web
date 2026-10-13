import type { PluginScreenProps } from '@getpaseo/plugin/client';
import { ScrollView, Text, View } from 'react-native';

export function SetupScreen({ theme, layout }: PluginScreenProps) {
  const text = { color: theme.colors.foreground, fontSize: 15, lineHeight: 23 };
  const muted = { ...text, color: theme.colors.foregroundMuted };
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 28, gap: 20 }}>
      <Text style={{ ...text, fontSize: 26, fontWeight: '600' }}>Gemini Web</Text>
      <Text style={text}>Google Pro 계정의 Gemini를 Paseo 대화에서 사용합니다. API 키를 입력할 필요가 없습니다.</Text>
      <View style={{ gap: 10 }}>
        <Text style={{ ...text, fontWeight: '600' }}>시작하기</Text>
        <Text style={text}>1. 호스트 설정 → Agents에서 Paseo tools와 Browser tools를 켭니다.</Text>
        <Text style={text}>2. 새 에이전트에서 Gemini Web → Gemini 4 Argon을 선택합니다.</Text>
        <Text style={text}>3. 첫 메시지를 보내면 전용 Gemini 탭이 열립니다. 로그인이 필요하면 그 탭에서 직접 로그인한 뒤 메시지를 다시 보내세요.</Text>
      </View>
      <View style={{ gap: 10 }}>
        <Text style={{ ...text, fontWeight: '600' }}>대화 설정</Text>
        <Text style={text}>최저가 · 보통 · 최고가는 Gemini 웹의 사고 수준 선택에 연결됩니다.</Text>
        <Text style={text}>대화 모드는 로컬 파일을 읽지 않습니다. 읽기 전용 모드는 작업 폴더의 내용을 읽어 Gemini에 전달합니다. 작업마다 승인 모드에서는 파일 읽기·수정·명령 실행 전에 확인합니다.</Text>
        <Text style={text}>명령 실행을 승인하면 명령은 컴퓨터에서 실행됩니다. 명령 자체는 작업 폴더 밖에도 접근할 수 있습니다.</Text>
        <Text style={text}>Deep Research 아이콘은 켜면 파란색, 끄면 회색으로 표시됩니다. 마우스를 올리면 켜짐·꺼짐도 확인할 수 있습니다. 좁은 화면에서는 Features 메뉴 안에서 변경합니다.</Text>
        <Text style={text}>조사 계획이 대화에 나타나면 연구 시작을 누르세요. 진행 상황은 같은 카드에 갱신되고, 완료된 보고서는 답변으로 표시됩니다. 계획을 바꾸려면 취소 후 변경 내용을 새 메시지로 보내세요.</Text>
        <Text style={text}>완료된 조사의 연결이 끊겼다면 새 에이전트에 /research-result 뒤로 Gemini 대화 URL을 붙여 보내 기존 보고서를 가져올 수 있습니다.</Text>
      </View>
      <Text style={muted}>Paseo Desktop을 켜 두어야 합니다. Gemini 웹의 사용량 제한이 그대로 적용됩니다. 웹 화면이 바뀌면 연결을 수정해야 할 수 있습니다. 대화와 파일 내용은 로그인한 Google 계정의 Gemini로 전송됩니다.</Text>
    </ScrollView>
  );
}
