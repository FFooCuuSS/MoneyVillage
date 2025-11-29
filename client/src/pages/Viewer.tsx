import { useEffect, useState } from 'react'
import { collection, onSnapshot, query, where, getDocs, doc } from 'firebase/firestore'
import { db } from '../firebase'
import HomeButton from '../components/HomeButton';

type Tx = {
  userId: string
  amount: number
}

type BoothTotals = {
  total: number;
  labor: number;
  bank: number;
  stock: number;
  realestate: number;
  quest: number;
  luck: number;
  group: number;
};

type RankRow = {
  userId: string;
} & BoothTotals;


export default function Viewer() {
  const [sessionId, setSessionId] = useState('dev-session')
  const [ranking, setRanking] = useState<RankRow[]>([])
  const [fullscreen, setFullscreen] = useState(false)
  const [msg, setMsg] = useState('')
  const [ended, setEnded] = useState(false)

  // 리더보드 집계
  useEffect(() => {
    if (!sessionId.trim()) {
      setRanking([]);
      return;
    }
    const q = query(collection(db, 'transactions'), where('sessionId', '==', sessionId))
    const unsub = onSnapshot(q, (snap) => {
      const userMap = new Map<string, BoothTotals>();
      snap.forEach((d) => {
        const tx = d.data() as any;
        const { userId, amount, boothId } = tx;
        if (!userId) return;

        const amt = Number(amount) || 0;

        if (!userMap.has(userId)) {
          userMap.set(userId, {
            total: 0,
            labor: 0,
            bank: 0,
            stock: 0,
            realestate: 0,
            quest: 0,
            luck: 0,
            group: 0,
          });
        }

        const obj = userMap.get(userId)!;
        obj.total += amt;

        if (boothId && obj.hasOwnProperty(boothId)) {
          (obj as any)[boothId] += amt;
        }
      });
      const arr = Array.from(userMap.entries()).map(([userId, totals]) => ({ userId, ...totals }));
      arr.sort((a, b) => b.total - a.total);
      setRanking(arr.slice(0, 10));
    })
    return () => unsub()
  }, [sessionId])

  // 세션 상태 구독 (sessions/{sessionId}.ended)
  useEffect(() => {
    if (!sessionId.trim()) {
        setEnded(false);
        return;
    }

    const ref = doc(db, 'sessions', sessionId)
    const unsub = onSnapshot(ref, (snap) => {
      const data = (snap.data() as any) || {}
      const isEnded =
        String(data.roundStatus || '').toUpperCase() === 'ENDED' ||
        String(data.status || '').toUpperCase() === 'CLOSED' ||
        Boolean(data.ended)
      setEnded(isEnded)
    })
    return () => unsub()
  }, [sessionId])


  // CSV 내보내기
  async function exportToCSV() {
  if (!ended) {
    setMsg('세션이 종료되지 않았습니다. (roundStatus: ENDED 또는 status: CLOSED 상태에서만 내보내기 가능)');
    return;
  }
  try {
    const q = query(collection(db, 'transactions'), where('sessionId', '==', sessionId));
    const snap = await getDocs(q);
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    if (rows.length === 0) {
      setMsg('데이터가 없습니다.');
      return;
    }

    const normalize = (r: any) => ({
      id: r.id ?? '',
      sessionId: r.sessionId ?? '',
      userId: r.userId ?? '',
      boothId: r.boothId ?? '',
      amount: typeof r.amount === 'number' ? r.amount : Number(r.amount ?? 0),
      createdAt: r.createdAt?.toDate
        ? r.createdAt.toDate().toLocaleString('ko-KR')
        : String(r.createdAt ?? '')
    });

    const data = rows.map(normalize);
    const headerKeys = Object.keys(data[0]);
    const header = headerKeys.join(',') + '\n';

    const esc = (v: any) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const body = data
      .map((r) => headerKeys.map((k) => esc((r as any)[k])).join(','))
      .join('\n');

    const csv = '\uFEFF' + header + body;

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transactions_${sessionId}_${new Date().toISOString()}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    setMsg('CSV 다운로드 완료');
  } catch (e: any) {
    console.error(e);
    setMsg(`오류: ${e?.message ?? String(e)}`);
  }
}

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen()
      setFullscreen(true)
    } else {
      document.exitFullscreen()
      setFullscreen(false)
    }
  }

  return (
    <div style={{
      padding: 20,
      maxWidth: 1200,
      margin: '0 auto',
      textAlign: 'left',
      color: '#fff'
    }}>
      <h1>Viewer — 리더보드</h1>

      <div style={{ marginTop: 8 }}>
        <label style={{ display: 'block', marginBottom: 6 }}>세션 ID</label>
        <input
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
          style={{ marginTop: 8, width: '500px', textAlign: 'center' }}
        />
      </div>

      <div style={{ marginTop: 8, fontSize: 14, color: ended ? '#22c55e' : '#f59e0b' }}>
        세션 상태: {ended ? '종료됨 (ENDED/CLOSED)' : '진행 중'}
      </div>

      <button
        onClick={toggleFullscreen}
        style={{
          marginTop: 16,
          background: fullscreen ? '#dc2626' : '#2563eb',
          color: '#fff',
          border: 'none',
          borderRadius: 6,
          padding: '8px 16px'
        }}
      >
        {fullscreen ? '전체화면 종료' : '전체화면 모드'}
      </button>

      <button
        onClick={exportToCSV}
        disabled={!ended}
        title={ended ? 'CSV로 내보내기' : '세션 종료(ENDED/CLOSED) 후 사용 가능합니다.'}
        style={{
          marginTop: 16,
          opacity: ended ? 1 : 0.6,
          cursor: ended ? 'pointer' : 'not-allowed'
        }}
      >
        CSV 다운로드
      </button>

      <p style={{ color:'#9ca3af', marginTop:8 }}>{msg}</p>

      <div style={{
        overflowX: 'auto',
        width: '100%',
        marginTop: 20,
        padding: '0 20px',
        boxSizing: 'border-box',
        textAlign: 'center'
      }}>
      <table style={{ width: '100%', minWidth: 1400, marginTop: 20, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #444' }}>
            <th style={{ textAlign: 'left', padding: '8px' }}>순위</th>
            <th style={{ textAlign: 'left', padding: '8px' }}>사용자</th>
            <th style={{ textAlign: 'right', padding: '8px' }}>합계</th>
            <th style={{ textAlign: 'center', padding: '8px' }}>노동</th>
            <th style={{ textAlign: 'center', padding: '8px' }}>은행</th>
            <th style={{ textAlign: 'center', padding: '8px' }}>주식</th>
            <th style={{ textAlign: 'center', padding: '8px' }}>부동산</th>
            <th style={{ textAlign: 'center', padding: '8px' }}>퀘스트</th>
            <th style={{ textAlign: 'center', padding: '8px' }}>행운</th>
            <th style={{ textAlign: 'center', padding: '8px' }}>단체게임</th>
          </tr>
        </thead>
        <tbody>
          {ranking.map((r, i) => (
            <tr key={r.userId} style={{ borderBottom: '1px solid #333' }}>
              <td style={{ padding: '8px', textAlign: 'left' }}>{i + 1}</td>
              <td style={{ padding: '8px', textAlign: 'left' }}>{r.userId}</td>
              <td style={{ padding: '8px', textAlign: 'right' }}>{r.total.toLocaleString()}</td>
              <td>{r.labor.toLocaleString()}</td>
              <td>{r.bank.toLocaleString()}</td>
              <td>{r.stock.toLocaleString()}</td>
              <td>{r.realestate.toLocaleString()}</td>
              <td>{r.quest.toLocaleString()}</td>
              <td>{r.luck.toLocaleString()}</td>
              <td>{r.group.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <HomeButton />
    </div>
  )
}
