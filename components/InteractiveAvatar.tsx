/**
 * ================================================
 * InteractiveAvatar.tsx - 경영학전공 AI 가이드
 * ================================================
 *
 * 기능:
 * 1. 탭 클릭 → postMessage → route.ts에서 고정 스크립트 → REPEAT 발화
 * 2. 음성 질문 → Web Speech API → OpenAI → REPEAT 발화
 * 3. 텍스트 질문 → OpenAI → REPEAT 발화
 *
 * 핵심: 아바타가 말할 때 Web Speech 일시정지 → 자기 목소리 인식 방지
 * 
 * 🔧 2026-01-12 수정:
 * - ElevenLabs 다국어 모델 → HeyGen 한국어 전용 음성 (SunHi) 변경
 * 
 * 🔧 2026-01-27 수정:
 * - allowedOrigins에 sungbongju.github.io 추가
 * 
 * 🔧 2026-02-28 수정:
 * - 교수님 Interactive Avatar로 변경
 * ================================================
 */

import {
  AvatarQuality,
  StreamingEvents,
  VoiceEmotion,
  StartAvatarRequest,
  TaskType,
} from "@heygen/streaming-avatar";
import { useEffect, useRef, useState, useCallback } from "react";
import { useMemoizedFn, useUnmount } from "ahooks";

import { useStreamingAvatarSession } from "./logic/useStreamingAvatarSession";
import { StreamingAvatarProvider, StreamingAvatarSessionState } from "./logic";
import { AVATARS } from "@/app/lib/constants";
import { WebSpeechRecognizer } from "@/app/lib/webSpeechAPI";

// 🔧 2026-02-28 수정: 교수님 Interactive Avatar로 변경
const AVATAR_CONFIG: StartAvatarRequest = {
  quality: AvatarQuality.Low,
  avatarName: "e2eb35c947644f09820aa3a4f9c15488",  // 교수님 아바타
  voice: {
    voiceId: "",  // 빈 값 → 아바타에 내장된 교수님 음성 자동 사용
    rate: 1.0,
    emotion: VoiceEmotion.FRIENDLY,
  },
  language: "ko",
};

// ============================================
// DB 저장 API 설정
// ============================================
const API_BASE = "https://aiforalab.com/business-api/api.php";

// DB에 대화 저장하는 함수
async function saveChatToDB(
  userMessage: string,
  botResponse: string,
  sessionId: string
) {
  const token = (window as any).__business_token;
  if (!token) return;

  try {
    await fetch(`${API_BASE}?action=save_chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        user_message: userMessage,
        bot_response: botResponse,
        session_id: sessionId,
      }),
    });
  } catch (e) {
    console.warn("⚠️ 대화 DB 저장 실패:", e);
  }
}

// ============================================
// 개인화 인사말 생성
// ============================================
function generateGreeting(userInfo: any): string {
  const name = userInfo?.name || '';
  const history = userInfo?.history;

  // 이력 정보가 없거나 첫 방문인 경우
  if (!history || history.visit_count <= 1) {
    if (name) {
      return `안녕하세요, ${name}님! 차 의과학 대학교 경영학 전공, 에이아이 가이드입니다. ${name}님의 방문을 환영합니다! 전공에 대해 궁금한 게 있으시면, 편하게 물어보세요!`;
    }
    return `안녕하세요! 차 의과학 대학교 경영학 전공, 에이아이 가이드입니다. 전공에 대해 궁금한 게 있으시면, 편하게 물어보세요!`;
  }

  // 재방문인 경우 — 개인화 인사말
  const visitCount = history.visit_count;
  const topics = history.recent_topics || [];

  // 경영학용 토픽 한국어 매핑
  const topicNames: Record<string, string> = {
    '연구분야': '연구분야',
    '커리큘럼': '커리큘럼',
    '취업': '취업과 진로',
    '세부전공': '세부 전공',
    '미래가치': '미래가치와 비전',
    '바이오': '바이오헬스케어',
    '졸업생': '졸업생 진로',
  };

  // 토픽 문자열 생성
  let topicStr = '';
  if (topics.length === 1) {
    topicStr = topicNames[topics[0]] || topics[0];
  } else if (topics.length === 2) {
    topicStr = `${topicNames[topics[0]] || topics[0]}과, ${topicNames[topics[1]] || topics[1]}`;
  } else if (topics.length >= 3) {
    topicStr = `${topicNames[topics[0]] || topics[0]}, ${topicNames[topics[1]] || topics[1]} 등`;
  }

  // 방문 횟수를 한글로
  const visitKorean = ['', '', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열'];
  const visitWord = visitCount <= 10
    ? `${visitKorean[visitCount]}번째`
    : `${visitCount}번째`;

  if (topicStr) {
    return `${name}님, ${visitWord} 방문을 환영합니다! 지난번에는, ${topicStr}에 대해 물어보셨죠. 오늘은 어떤 부분이 궁금하세요?`;
  }

  return `${name}님, ${visitWord} 방문을 환영합니다! 오늘은 어떤 것이 궁금하세요?`;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function InteractiveAvatar() {
  const {
    initAvatar,
    startAvatar,
    stopAvatar,
    sessionState,
    stream,
    avatarRef,
  } = useStreamingAvatarSession();

  // UI 상태
  const [inputText, setInputText] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [isAvatarSpeaking, setIsAvatarSpeaking] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [currentTab, setCurrentTab] = useState<string>("");
  const mediaStream = useRef<HTMLVideoElement>(null);

  // 내부 상태 refs
  const isProcessingRef = useRef(false);
  const hasGreetedRef = useRef(false);
  const hasStartedRef = useRef(false);

  // Web Speech API ref
  const webSpeechRef = useRef<WebSpeechRecognizer | null>(null);
  const isAvatarSpeakingRef = useRef(false);

  // 사용자 정보 (로그인 후 postMessage로 수신)
  const userInfoRef = useRef<any>(null);

  // ============================================
  // API 호출
  // ============================================
  const fetchAccessToken = async () => {
    const response = await fetch("/api/get-access-token", { method: "POST" });
    const token = await response.text();
    console.log("Access Token:", token);
    return token;
  };

  // 🎯 탭 설명 API 호출 (고정 스크립트 반환)
  const fetchTabScript = async (tabId: string): Promise<string> => {
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "tab_explain",
          tabId: tabId,
        }),
      });
      const data = await response.json();
      return data.reply || "설명을 불러올 수 없습니다.";
    } catch (error) {
      console.error("Tab script API error:", error);
      return "죄송합니다. 오류가 발생했습니다.";
    }
  };

  // 💬 일반 채팅 API 호출 (OpenAI)
  const callOpenAI = async (message: string, history: ChatMessage[]) => {
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: message,
          history: history,
        }),
      });
      const data = await response.json();
      console.log("📦 API raw response:", data);
      return data; // 전체 객체 반환 { reply, action, tabId }
    } catch (error) {
      console.error("OpenAI API error:", error);
      return { reply: "죄송합니다. 일시적인 오류가 발생했습니다. 다시 말씀해 주세요.", action: "none", tabId: null };
    }
  };

  // ============================================
  // 아바타 음성 출력 (Web Speech 일시정지 포함)
  // ============================================
  const speakWithAvatar = useCallback(
    async (text: string) => {
      if (!avatarRef.current || !text) return;

      try {
        // 🔇 Web Speech 완전히 정지
        console.log("🔇 Web Speech 일시정지");
        isAvatarSpeakingRef.current = true;
        setIsAvatarSpeaking(true);
        webSpeechRef.current?.pause();

        // 잠시 대기 (Web Speech가 완전히 멈출 때까지)
        await new Promise((r) => setTimeout(r, 300));

        // HeyGen 자동 응답 차단
        try {
          await avatarRef.current.interrupt();
        } catch {
          // ignore
        }

        console.log("🗣️ Avatar speaking:", text);
        await avatarRef.current.speak({
          text,
          taskType: TaskType.REPEAT,
        });
      } catch (error) {
        console.error("Avatar speak error:", error);
        isAvatarSpeakingRef.current = false;
        setIsAvatarSpeaking(false);
        webSpeechRef.current?.resume();
      }
    },
    [avatarRef],
  );

  // ============================================
  // 🎤 사용자 음성 처리 (Web Speech API용)
  // ============================================
  const handleUserSpeech = useCallback(
    async (transcript: string) => {
      if (isAvatarSpeakingRef.current) {
        console.log("⏸️ 아바타가 말하는 중 - 무시:", transcript);
        return;
      }

      if (!transcript.trim() || isProcessingRef.current) return;

      isProcessingRef.current = true;
      setIsLoading(true);
      setInterimTranscript("");
      console.log("🎯 User said:", transcript);

      setChatHistory((prev) => {
        const newHistory = [
          ...prev,
          { role: "user" as const, content: transcript },
        ];

        callOpenAI(transcript, prev).then(async (response) => {
          console.log("🎯 OpenAI response:", response);
          
          const reply = response.reply || response;
          const action = response.action;
          const navigateTabId = response.tabId;

          setChatHistory((current) => [
            ...current,
            { role: "assistant" as const, content: reply },
          ]);

          // 🎯 navigate면 reply 대신 탭 스크립트만 발화
          if (action === "navigate" && navigateTabId) {
            console.log("📑 Navigate to tab:", navigateTabId);
            window.parent.postMessage({
              type: "NAVIGATE_TAB",
              tabId: navigateTabId
            }, "*");

            const script = await fetchTabScript(navigateTabId);
            if (script) {
              await speakWithAvatar(script);
            }
          } else {
            await speakWithAvatar(reply);
          }

          // ★ 대화 DB 저장
          saveChatToDB(transcript, reply, (window as any).__business_session || "default");

          setIsLoading(false);
          isProcessingRef.current = false;
        });

        return newHistory;
      });
    },
    [speakWithAvatar],
  );

  // ============================================
  // 🎯 탭 변경 처리
  // ============================================
  const handleTabChange = useCallback(
    async (tabId: string) => {
      if (isProcessingRef.current) return;
      isProcessingRef.current = true;

      console.log("📑 Tab changed:", tabId);
      setCurrentTab(tabId);
      setIsLoading(true);

      // 🔇 먼저 Web Speech 일시정지
      console.log("🔇 Tab change - Web Speech 일시정지");
      isAvatarSpeakingRef.current = true;
      setIsAvatarSpeaking(true);
      webSpeechRef.current?.pause();

      // 현재 발화 중이면 중단
      if (avatarRef.current) {
        try {
          await avatarRef.current.interrupt();
        } catch {
          // ignore
        }
      }

      // API에서 스크립트 가져오기
      const script = await fetchTabScript(tabId);

      // 아바타로 발화 (speakWithAvatar 내부에서 다시 pause 호출해도 OK)
      if (avatarRef.current && script) {
        try {
          console.log("🗣️ Avatar speaking:", script);
          await avatarRef.current.speak({
            text: script,
            taskType: TaskType.REPEAT,
          });
        } catch (error) {
          console.error("Avatar speak error:", error);
        }
      }

      setIsLoading(false);
      isProcessingRef.current = false;
    },
    [avatarRef],
  );

  // ============================================
  // Web Speech API 초기화
  // ============================================
  const initWebSpeech = useCallback(() => {
    if (webSpeechRef.current) {
      console.log("🎤 Web Speech 이미 초기화됨");
      return;
    }

    if (!WebSpeechRecognizer.isSupported()) {
      console.error("🎤 Web Speech API 지원하지 않는 브라우저");
      alert(
        "이 브라우저는 음성 인식을 지원하지 않습니다. Chrome 또는 Edge를 사용해주세요.",
      );
      return;
    }

    webSpeechRef.current = new WebSpeechRecognizer(
      {
        onResult: (transcript: string, isFinal: boolean) => {
          if (isAvatarSpeakingRef.current) return;

          if (isFinal) {
            console.log("🎤 Final:", transcript);
            handleUserSpeech(transcript);
          } else {
            setInterimTranscript(transcript);
          }
        },
        onStart: () => {
          console.log("🎤 Web Speech 시작");
          setIsListening(true);
        },
        onEnd: () => {
          console.log("🎤 Web Speech 종료");
          setIsListening(false);
        },
        onError: (error: string) => {
          console.error("🎤 Web Speech 에러:", error);
          // 마이크 권한 거부 시 alert 없이 조용히 처리 (마이크 없는 환경 대응)
        },
      },
      {
        lang: "ko-KR",
        continuous: true,
        interimResults: true,
        autoRestart: true,
      },
    );

    console.log("🎤 Web Speech API 초기화 완료");
  }, [handleUserSpeech]);

  // ============================================
  // 세션 초기화
  // ============================================
  const resetSession = useMemoizedFn(async () => {
    console.log("🔄 세션 초기화 중...");

    // Web Speech 정리
    if (webSpeechRef.current) {
      webSpeechRef.current.destroy();
      webSpeechRef.current = null;
    }

    // HeyGen 세션 정리 (여러 방법 시도)
    try {
      if (avatarRef.current) {
        await avatarRef.current.stopAvatar();
      }
    } catch (e) {
      console.log("stopAvatar 에러 (무시):", e);
    }

    try {
      await stopAvatar();
    } catch (e) {
      console.log("stopAvatar hook 에러 (무시):", e);
    }

    // 상태 초기화
    hasStartedRef.current = false;
    hasGreetedRef.current = false;
    isProcessingRef.current = false;
    isAvatarSpeakingRef.current = false;
    setChatHistory([]);
    setIsLoading(false);
    setIsListening(false);
    setIsAvatarSpeaking(false);
    setInterimTranscript("");
    setCurrentTab("");

    await new Promise((r) => setTimeout(r, 1000)); // 1초 대기
    console.log("🔄 세션 초기화 완료");
  });

  // ============================================
  // 세션 시작
  // ============================================
  const startSession = useMemoizedFn(async () => {
    if (hasStartedRef.current) {
      console.log("⚠️ 이미 세션 시작됨, 무시");
      return;
    }
    hasStartedRef.current = true;

    try {
      const token = await fetchAccessToken();
      const avatar = initAvatar(token);

      avatar.on(StreamingEvents.STREAM_READY, async (event) => {
        console.log("Stream ready:", event.detail);

        // ★ 부모 페이지에 아바타 준비 완료 알림
        try { window.parent.postMessage({ type: 'AVATAR_READY' }, '*'); } catch(e) {}

        if (!hasGreetedRef.current) {
          await new Promise((r) => setTimeout(r, 1500));

          // ★ USER_INFO가 이미 있으면 즉시 개인화 인사
          if (userInfoRef.current) {
            const greeting = generateGreeting(userInfoRef.current);
            console.log("👋 개인화 인사말:", greeting);
            await speakWithAvatar(greeting);
            setChatHistory([{ role: "assistant", content: greeting }]);
            hasGreetedRef.current = true;
          } else {
            // USER_INFO 대기 (3초 후 기본 인사말)
            console.log("⏳ USER_INFO 대기 중... (3초 타임아웃)");
            await new Promise((r) => setTimeout(r, 3000));
            if (!hasGreetedRef.current) {
              const greeting =
                "안녕하세요! 차 의과학 대학교 경영학 전공, 에이아이 가이드입니다. 궁금한 부분을 클릭하거나, 질문을 말씀해주세요!";
              console.log("👋 기본 인사말:", greeting);
              await speakWithAvatar(greeting);
              setChatHistory([{ role: "assistant", content: greeting }]);
              hasGreetedRef.current = true;
            }
          }
        }
      });

      avatar.on(StreamingEvents.STREAM_DISCONNECTED, () => {
        console.log("Stream disconnected");
        hasGreetedRef.current = false;
        hasStartedRef.current = false;

        webSpeechRef.current?.destroy();
        webSpeechRef.current = null;
      });

      avatar.on(StreamingEvents.AVATAR_START_TALKING, () => {
        console.log("🗣️ Avatar started talking - Web Speech 일시정지");
        isAvatarSpeakingRef.current = true;
        setIsAvatarSpeaking(true);
        webSpeechRef.current?.pause();
      });

      avatar.on(StreamingEvents.AVATAR_STOP_TALKING, async () => {
        console.log("🔈 Avatar stopped talking - Web Speech 재개");
        isAvatarSpeakingRef.current = false;
        setIsAvatarSpeaking(false);

        await new Promise((r) => setTimeout(r, 500));
        webSpeechRef.current?.resume();
        console.log("🎤 Web Speech 재개 완료");
      });

      await startAvatar(AVATAR_CONFIG);

      // 마이크 자동 시작 (실패해도 조용히 처리)
      console.log("🎤 Web Speech API 시작...");
      initWebSpeech();

      setTimeout(() => {
        webSpeechRef.current?.start();
        console.log("🎤 Web Speech 인식 시작");
      }, 2000);
    } catch (error) {
      console.error("Session error:", error);
      hasStartedRef.current = false;
    }
  });

  // ============================================
  // 텍스트 메시지 전송
  // ============================================
  const handleSendMessage = useMemoizedFn(async () => {
    const text = inputText.trim();
    if (!text || !avatarRef.current || isLoading) return;

    setInputText("");
    setIsLoading(true);

    const newHistory = [
      ...chatHistory,
      { role: "user" as const, content: text },
    ];

    setChatHistory(newHistory);

    const response = await callOpenAI(text, chatHistory);
    
    const reply = response.reply || response;
    const action = response.action;
    const navigateTabId = response.tabId;

    setChatHistory([
      ...newHistory,
      { role: "assistant" as const, content: reply },
    ]);

    // 🎯 navigate면 reply 대신 탭 스크립트만 발화
    if (action === "navigate" && navigateTabId) {
      console.log("📑 Navigate to tab:", navigateTabId);
      window.parent.postMessage({
        type: "NAVIGATE_TAB",
        tabId: navigateTabId
      }, "*");

      const script = await fetchTabScript(navigateTabId);
      if (script) {
        await speakWithAvatar(script);
      }
    } else {
      await speakWithAvatar(reply);
    }

    // ★ 대화 DB 저장
    saveChatToDB(text, reply, (window as any).__business_session || "default");

    setIsLoading(false);
  });

  // ============================================
  // 마이크 토글 버튼 핸들러
  // ============================================
  const toggleMicrophone = useCallback(() => {
    if (!webSpeechRef.current) {
      initWebSpeech();
      setTimeout(() => {
        webSpeechRef.current?.start();
      }, 100);
      return;
    }

    if (webSpeechRef.current.getIsPaused()) {
      webSpeechRef.current.resume();
    } else {
      webSpeechRef.current.pause();
    }
  }, [initWebSpeech]);

  // ============================================
  // postMessage 통신 (메인 페이지와)
  // ============================================
  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      // origin 검증 (보안)
      const allowedOrigins = [
        "https://sdkparkforbi.github.io",
        "https://sungbongju.github.io",  // 🆕 본인 GitHub Pages 추가
        "http://localhost",
        "http://127.0.0.1",
      ];

      const isAllowed = allowedOrigins.some((origin) =>
        event.origin.startsWith(origin)
      );

      if (!isAllowed) {
        console.log("⚠️ Ignored message from:", event.origin);
        return;
      }

      const { type, tabId, question } = event.data || {};
      console.log("📥 Received message:", { type, tabId, question, origin: event.origin });

      // ★ 로그인된 사용자 정보 + 이력 수신 (최초 1회만 처리)
      if (type === "USER_INFO" && event.data.user) {
        // 이미 유저 정보 있으면 무시 (중복 전송 방지)
        if (userInfoRef.current) {
          console.log("👤 USER_INFO 중복 수신 무시:", event.data.user.name);
          return;
        }

        userInfoRef.current = {
          name: event.data.user.name,
          student_id: event.data.user.student_id,
          history: event.data.history || null,
        };

        // 토큰 저장 (대화 DB 저장에 사용)
        if (event.data.token) {
          (window as any).__business_token = event.data.token;
        }
        if (event.data.sessionId) {
          (window as any).__business_session = event.data.sessionId;
        }
        console.log("👤 사용자 정보 수신:", event.data.user.name);

        // ★ 아바타가 이미 준비됐지만 아직 인사 안 한 경우 → 즉시 개인화 인사
        if (avatarRef.current && hasGreetedRef.current === false && hasStartedRef.current) {
          const greeting = generateGreeting(userInfoRef.current);
          console.log("👋 개인화 인사말 (USER_INFO 도착 후):", greeting);
          await speakWithAvatar(greeting);
          setChatHistory([{ role: "assistant", content: greeting }]);
          hasGreetedRef.current = true;
        }

        // ★ 아바타가 아직 시작되지 않았으면 자동 시작
        if (!hasStartedRef.current) {
          console.log("🚀 USER_INFO 수신 → 아바타 자동 시작");
          startSession();
        }
      }

      if (type === "TAB_CHANGED" && tabId) {
        handleTabChange(tabId);
      }

      // 🎯 외부에서 질문 보내기 (콘솔 또는 랜딩페이지 CTA 버튼)
      if (type === "ASK_QUESTION" && question) {
        console.log("💬 ASK_QUESTION:", question);
        if (!avatarRef.current || isProcessingRef.current) {
          console.log("⚠️ 아바타 미연결 또는 처리 중 - 무시");
          return;
        }
        isProcessingRef.current = true;
        setIsLoading(true);

        setChatHistory((prev) => {
          const newHistory = [
            ...prev,
            { role: "user" as const, content: question },
          ];

          callOpenAI(question, prev).then(async (response) => {
            const reply = response.reply || response;
            const action = response.action;
            const navigateTabId = response.tabId;

            setChatHistory((current) => [
              ...current,
              { role: "assistant" as const, content: reply },
            ]);

            // 🎯 navigate면 reply 대신 탭 스크립트만 발화
            if (action === "navigate" && navigateTabId) {
              window.parent.postMessage({
                type: "NAVIGATE_TAB",
                tabId: navigateTabId,
              }, "*");

              const script = await fetchTabScript(navigateTabId);
              if (script) {
                await speakWithAvatar(script);
              }
            } else {
              await speakWithAvatar(reply);
            }

            setIsLoading(false);
            isProcessingRef.current = false;
          });

          return newHistory;
        });
      }

      // 아바타 시작 신호
      if (type === "START_AVATAR") {
        if (!hasStartedRef.current) {
          startSession();
        }
      }

      // 아바타 세션 종료 (X 버튼)
      if (type === "CLOSE_AVATAR") {
        console.log("🛑 CLOSE_AVATAR 수신 → 세션 종료");
        webSpeechRef.current?.destroy();
        webSpeechRef.current = null;
        try {
          await stopAvatar();
        } catch {
          // ignore
        }
        hasStartedRef.current = false;
        hasGreetedRef.current = false;
        userInfoRef.current = null;
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleTabChange, startSession]);

  // 언마운트 시 정리
  useUnmount(() => {
    webSpeechRef.current?.destroy();

    try {
      stopAvatar();
    } catch {
      // ignore
    }
  });

  // ============================================
  // 🔄 페이지 새로고침/닫기 전 세션 정리
  // ============================================
  useEffect(() => {
    const handleBeforeUnload = () => {
      console.log("🔄 beforeunload - 세션 정리 중...");
      
      // Web Speech 정리
      if (webSpeechRef.current) {
        webSpeechRef.current.destroy();
        webSpeechRef.current = null;
      }
      
      // HeyGen 세션 정리
      if (avatarRef.current) {
        try {
          avatarRef.current.stopAvatar();
        } catch {
          // ignore
        }
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [avatarRef]);

  // 비디오 스트림 연결
  useEffect(() => {
    if (stream && mediaStream.current) {
      mediaStream.current.srcObject = stream;
      mediaStream.current.onloadedmetadata = () => mediaStream.current?.play();
    }
  }, [stream]);

  // ============================================
  // UI
  // ============================================
  const getStatusText = () => {
    if (isAvatarSpeaking) return "설명 중...";
    if (isListening) return "듣는 중... 말씀하세요";
    if (isLoading) return "생각 중...";
    return "텍스트로 질문하세요";
  };

  const getStatusColor = () => {
    if (isAvatarSpeaking) return "bg-blue-500";
    if (isListening) return "bg-red-500 animate-pulse";
    if (isLoading) return "bg-yellow-500";
    return "bg-green-500";
  };

  return (
    <div className="w-full h-full flex flex-col">
      {sessionState === StreamingAvatarSessionState.CONNECTED && stream ? (
        <div className="flex-1 relative flex flex-col">
          <div className="relative flex-shrink-0">
            <video
              ref={mediaStream}
              autoPlay
              playsInline
              style={{ display: "block", width: "100%", height: "auto" }}
            />

            {/* 종료 버튼 */}
            <button
              className="absolute top-2 right-2 w-7 h-7 bg-black/50 hover:bg-red-600 text-white rounded-full flex items-center justify-center text-xs"
              onClick={() => resetSession()}
            >
              ✕
            </button>

            {/* 마이크 토글 버튼 */}
            <button
              className={`absolute top-2 left-2 w-7 h-7 ${
                isListening
                  ? "bg-red-500 animate-pulse"
                  : "bg-black/50 hover:bg-green-600"
              } text-white rounded-full flex items-center justify-center text-sm`}
              disabled={isAvatarSpeaking}
              title={isListening ? "마이크 끄기" : "마이크 켜기"}
              onClick={toggleMicrophone}
            >
              {isListening ? "🎤" : "🎙️"}
            </button>

            {/* 상태 표시 */}
            <div className="absolute bottom-2 left-2 flex items-center gap-2">
              <div className={`w-3 h-3 rounded-full ${getStatusColor()}`} />
              <span className="text-white text-xs bg-black/50 px-2 py-1 rounded">
                {getStatusText()}
              </span>
            </div>

            {/* 현재 탭 표시 */}
            {currentTab && (
              <div className="absolute bottom-2 right-2">
                <span className="text-white text-xs bg-purple-600/80 px-2 py-1 rounded">
                  📑 {currentTab}
                </span>
              </div>
            )}

            {/* 중간 인식 결과 표시 */}
            {interimTranscript && (
              <div className="absolute bottom-10 left-2 right-2">
                <div className="bg-black/70 text-white text-xs px-2 py-1 rounded">
                  🎤 &quot;{interimTranscript}&quot;
                </div>
              </div>
            )}
          </div>

          {/* 텍스트 입력 */}
          <div className="p-2 bg-zinc-800 border-t border-zinc-700">
            <div className="flex gap-2">
              <input
                className="flex-1 px-3 py-2 bg-zinc-700 text-white text-sm rounded-lg border border-zinc-600 focus:outline-none focus:border-purple-500 disabled:opacity-50"
                disabled={isLoading || isAvatarSpeaking}
                placeholder="또는 텍스트로 질문하세요..."
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) =>
                  e.key === "Enter" && !e.shiftKey && handleSendMessage()
                }
              />
              <button
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-zinc-600 text-white text-sm rounded-lg"
                disabled={isLoading || isAvatarSpeaking || !inputText.trim()}
                onClick={handleSendMessage}
              >
                {isLoading ? "..." : "전송"}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-zinc-900 via-zinc-800 to-zinc-900">
          {sessionState === StreamingAvatarSessionState.CONNECTING ? (
            <div className="flex flex-col items-center gap-4">
              <div className="relative w-16 h-16">
                <div className="absolute inset-0 rounded-full border-2 border-purple-500/30 animate-ping" />
                <div className="absolute inset-2 rounded-full border-2 border-purple-400 border-t-transparent animate-spin" />
                <div className="absolute inset-0 flex items-center justify-center text-2xl">💬</div>
              </div>
              <span className="text-zinc-300 text-sm tracking-wide">AI 가이드 연결 중...</span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-5">
              <div className="relative group cursor-pointer" onClick={startSession}>
                <div className="absolute -inset-1 bg-gradient-to-r from-purple-600 to-indigo-600 rounded-full blur opacity-60 group-hover:opacity-100 transition duration-500" />
                <div className="relative w-20 h-20 bg-zinc-900 rounded-full flex items-center justify-center border border-zinc-700 group-hover:border-purple-500 transition-all duration-300">
                  <svg className="w-8 h-8 text-purple-400 group-hover:text-white transition-colors duration-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                </div>
              </div>
              <div className="text-center">
                <p className="text-white text-sm font-medium">대화를 시작하려면 터치하세요</p>
                <p className="text-zinc-500 text-xs mt-1">음성으로 질문할 수 있습니다</p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function InteractiveAvatarWrapper() {
  return (
    <StreamingAvatarProvider basePath={process.env.NEXT_PUBLIC_BASE_API_URL}>
      <InteractiveAvatar />
    </StreamingAvatarProvider>
  );
}
