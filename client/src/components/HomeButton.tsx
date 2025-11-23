import { useEffect, useState } from 'react';

export default function HomeButton() {
  const [canInstall, setCanInstall] = useState(false);
  const [deferredEvt, setDeferredEvt] = useState<any>(null);

  useEffect(() => {
    // Vite 개발환경/일반 브라우저에서만 동작
    if (typeof window === 'undefined') return;

    // beforeinstallprompt 이벤트 핸들링 (크롬/안드로이드)
    const onBip = (e: any) => {
      try {
        e.preventDefault();
        setDeferredEvt(e);
        setCanInstall(true);
      } catch (_) { /* no-op */ }
    };

    window.addEventListener('beforeinstallprompt', onBip);
    return () => window.removeEventListener('beforeinstallprompt', onBip);
  }, []);

  const handleClick = async () => {
    try {
      if (deferredEvt) {
        // PWA 설치 프로ンプ트
        deferredEvt.prompt?.();
        await deferredEvt.userChoice?.();
        setDeferredEvt(null);
        setCanInstall(false);
        return;
      }
      // 설치 불가 환경이면 홈으로 이동만
      window.location.href = '/';
    } catch {
      // 마지막 안전망: 그냥 홈으로
      window.location.href = '/';
    }
  };

  return (
    <button
      onClick={handleClick}
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        padding: '10px 14px',
        borderRadius: 10,
        border: '1px solid #333',
        background: '#111',
        color: '#fff',
        cursor: 'pointer',
        boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
        zIndex: 9999
      }}
      aria-label="홈 화면으로"
      title={canInstall ? '홈 화면에 추가' : '홈으로'}
    >
      {canInstall ? '홈 화면에 추가' : 'Home'}
    </button>
  );
}
