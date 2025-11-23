// src/pages/Admin.tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  collection, doc, getDocs, limit, onSnapshot, query, serverTimestamp,
  setDoc, updateDoc, where
} from 'firebase/firestore';
import { db, ensureAnon } from '../firebase';

type RoundStatus = 'READY' | 'RUNNING' | 'ENDED';

type AssetScenario = {
  name: string;
  prices: number[];
};


function toDateAny(v: any): Date | null {
  if (!v) return null;
  if (typeof v.toDate === 'function') return v.toDate();
  if (v instanceof Date) return v;
  if (typeof v.seconds === 'number') return new Date(v.seconds * 1000);
  if (typeof v === 'number') return new Date(v);
  return null;
}

export default function Admin() {
  const [sessionId, setSessionId] = useState('');
  const [roundStatus, setRoundStatus] = useState<RoundStatus>('READY');
  const [durationSec, setDurationSec] = useState(1200);
  const [endsAt, setEndsAt] = useState<Date | null>(null);
  const [booting, setBooting] = useState(true);
  const [msg, setMsg] = useState('');

  const timerRef = useRef<number | null>(null);
  const [remaining, setRemaining] = useState<number>(durationSec);

  const [stockScenario, setStockScenario] = useState<AssetScenario[]>([]);
  const [realEstateScenario, setRealEstateScenario] = useState<AssetScenario[]>([]);

  // 1) 초기 부팅: 로그인 + 기본 세션 ID 결정
useEffect(() => {
  (async () => {
    try {
      setBooting(true);
      await ensureAnon();

      const qOpen = query(collection(db, 'sessions'), where('status','==','OPEN'), limit(1));
      const qopen = query(collection(db, 'sessions'), where('status','==','open'), limit(1));
      let snap = await getDocs(qOpen);
      if (snap.empty) snap = await getDocs(qopen);

      if (!snap.empty) {
        const id = snap.docs[0].id;
        await updateDoc(doc(db, 'sessions', id), { status: 'OPEN' });
        setSessionId(id);
      } else {
        // 기본값만 세팅(READY에서 개설)
        setSessionId('dev-session');
        setRoundStatus('READY');
        setEndsAt(null);
      }
    } catch (e:any) {
      console.error(e);
      setMsg(`부팅 실패: ${e?.message ?? String(e)}`);
    } finally {
      setBooting(false);
    }
  })();
}, []);

// 2) 세션 문서 구독: sessionId가 바뀔 때마다 새로 attach
useEffect(() => {
  if (!sessionId) return;
  const unsubscribe = onSnapshot(
    doc(db, 'sessions', sessionId),
    (d) => {
      const data = d.data();
      if (!data) return;
      setRoundStatus((data.roundStatus ?? 'READY') as RoundStatus);
      setDurationSec(Number(data.roundDurationSec ?? 1200) || 1200);
      setEndsAt(toDateAny(data.roundEndsAt));
      setStockScenario((data.stockScenario ?? []) as AssetScenario[]);
      setRealEstateScenario((data.realEstateScenario ?? []) as AssetScenario[]);
    },
    (err) => setMsg(`구독 오류: ${String(err)}`)
  );
  return () => unsubscribe();
}, [sessionId]);


  // 남은 시간 계산
  useEffect(() => {
  // 항상 기존 타이머 정리
  if (timerRef.current) {
    window.clearInterval(timerRef.current);
    timerRef.current = null;
  }

  // RUNNING + endsAt 유효할 때만 타이머 동작
  if (roundStatus === 'RUNNING' && endsAt instanceof Date && Number.isFinite(endsAt.getTime())) {
    const compute = () => {
      const sec = Math.ceil((endsAt.getTime() - Date.now()) / 1000);
      if (sec <= 0) {
        setRemaining(0);
        if (timerRef.current) {
          window.clearInterval(timerRef.current);
          timerRef.current = null;
        }
        // 🔸 여기서 stopRound()는 부르지 말자 (클라마다 쓰기 경쟁 방지)
        return;
      }
      setRemaining(sec);
    };

    // 즉시 1회 계산(“시작” 누르자마자 화면 반영)
    compute();

    // 이후 1초 간격
    timerRef.current = window.setInterval(compute, 1000) as unknown as number;

    // cleanup
    return () => {
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }

  // READY/ENDED일 땐 표시용 기본값
  setRemaining(Number(durationSec) || 1200);
}, [roundStatus, endsAt]);

  async function startRound() {
    try {
      if (!sessionId) return;
      const dur = Number(durationSec);
      if (!Number.isFinite(dur) || dur <= 0) throw new Error('라운드 길이가 올바르지 않습니다');
      const end = new Date(Date.now() + dur * 1000);
      await updateDoc(doc(db, 'sessions', sessionId), {
        status: 'OPEN',
        roundStatus: 'RUNNING',
        roundDurationSec: dur,
        roundEndsAt: end,
        updatedAt: serverTimestamp(),
      });
      setMsg('라운드 시작');
    } catch (e: any) {
      console.error(e);
      setMsg(`시작 실패: ${e?.message ?? String(e)}`);
    }
  }

  async function createOrReadySession() {
  try {
    if (!sessionId.trim()) throw new Error('세션 ID를 입력하세요');

    const qOpen = query(collection(db, 'sessions'), where('status', '==', 'OPEN'));
    const openSnap = await getDocs(qOpen);
    await Promise.all(openSnap.docs
      .filter(d => d.id !== sessionId)
      .map(d => updateDoc(d.ref, { status: 'CLOSED' })));

    const dur = Number(durationSec) || 1200;

    // 🔹 새 시나리오 생성
    const scenario = generateScenario(dur);
    const realEstateOwnersInit = Object.fromEntries(
      scenario.realEstate.map(a => [a.name, null as string | null])
    );
    await setDoc(doc(db, 'sessions', sessionId), {
      name: sessionId,
      status: 'OPEN',
      roundStatus: 'READY',
      roundDurationSec: dur,
      roundEndsAt: null,
      startedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      stockScenario: scenario.stock,
      realEstateScenario: scenario.realEstate,
      realEstateOwners: realEstateOwnersInit,
    }, { merge: true });

    // 로컬 상태도 동기화
    setRoundStatus('READY');
    setEndsAt(null);
    setStockScenario(scenario.stock);
    setRealEstateScenario(scenario.realEstate);
    setMsg(`세션 개설/전환 완료: ${sessionId}`);
  } catch (e:any) {
    console.error(e);
    setMsg(`개설 실패: ${e?.message ?? String(e)}`);
  }
}



  async function stopRound() {
    try {
      if (!sessionId) return;
      await updateDoc(doc(db, 'sessions', sessionId), {
        roundStatus: 'ENDED',
        roundEndsAt: null,
        updatedAt: serverTimestamp(),
      });
      setMsg('라운드 종료');
    } catch (e: any) {
      console.error(e);
      setMsg(`종료 실패: ${e?.message ?? String(e)}`);
    }
  }

async function refreshScenario() {
  try {
    if (!sessionId) throw new Error('세션 없음');
    if (roundStatus !== 'READY') throw new Error('READY 상태에서만 변경 가능합니다.');

    const dur = Number(durationSec) || 1200;
    const scenario = generateScenario(dur);

    await updateDoc(doc(db, 'sessions', sessionId), {
      stockScenario: scenario.stock,
      realEstateScenario: scenario.realEstate,
      updatedAt: serverTimestamp(),
    });

    setStockScenario(scenario.stock);
    setRealEstateScenario(scenario.realEstate);
    setMsg('시나리오를 새로 생성했습니다.');
  } catch (e:any) {
    console.error(e);
    setMsg(`시나리오 갱신 실패: ${e?.message ?? String(e)}`);
  }
}

const STEP_MIN = 10;          // 변동 주기

// 주식 기본값
const STOCK_BASE_PRICE = 50000;
const STOCK_DELTA = 20000;

// 부동산 기본값
const RE_BASE_PRICE = 200000;
const RE_DELTA = 50000;

function genPricePathStock(steps: number): number[] {
  const arr: number[] = [STOCK_BASE_PRICE];
  for (let i = 1; i < steps; i++) {
    const prev = arr[i - 1];
    const delta = Math.floor(Math.random() * (STOCK_DELTA * 2 + 1)) - STOCK_DELTA;
    const next = Math.max(0, prev + delta);
    arr.push(next);
  }
  return arr;
}

function genPricePathRealEstate(steps: number): number[] {
  const arr: number[] = [RE_BASE_PRICE];
  for (let i = 1; i < steps; i++) {
    const prev = arr[i - 1];
    const delta = Math.floor(Math.random() * (RE_DELTA * 2 + 1)) - RE_DELTA;
    const next = Math.max(0, prev + delta);
    arr.push(next);
  }
  return arr;
}

function generateScenario(durationSec: number): {
  stock: AssetScenario[];
  realEstate: AssetScenario[];
} {
  const steps = Math.max(1, Math.floor(durationSec / (STEP_MIN * 60))); // 1200초 -> 5
  const stockNames = ['주식 A', '주식 B', '주식 C', '주식 D', '주식 E', '주식 F'];
  const reNames = ['부동산 A', '부동산 B', '부동산 C', '부동산 D', '부동산 E', '부동산 F'];

  const stock = stockNames.map(name => ({
    name,
    prices: genPricePathStock(steps)
  }));

  const realEstate = reNames.map(name => ({
    name,
    prices: genPricePathRealEstate(steps)
  }));

  return { stock, realEstate };
}


  const mmss = useMemo(() => {
    const sec = Math.max(0, Number(remaining) || 0);
    const m = Math.floor(sec / 60).toString().padStart(2, '0');
    const s = (sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }, [remaining]);

  const color =
    roundStatus === 'RUNNING' ? '#16a34a' :
    roundStatus === 'READY'   ? '#6b7280' : '#dc2626';

  // 시나리오 시간 라벨 (0, 4, 8, ...)
  const stepCount =
    stockScenario[0]?.prices.length ??
    realEstateScenario[0]?.prices.length ??
    Math.max(1, Math.floor((durationSec || 1200) / (STEP_MIN * 60)));

  const timeLabels = Array.from({ length: stepCount }, (_, i) => i * STEP_MIN);

  return (
    <div style={{ padding: 20 }}>
      <h1>Admin — 라운드 타이머</h1>

      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', marginTop: 16 }}>
        {/* 🔹 왼쪽: 타이머 / 세션 설정 */}
        <div style={{ maxWidth: 520, width: '100%' }}>
          <div style={{ marginTop: 8 }}>
            <label>세션 ID</label>
            <input value={sessionId} onChange={(e)=>setSessionId(e.target.value)} style={{ width:'100%' }}/>
          </div>

          <div style={{ marginTop: 12 }}>
            <label>라운드 길이(초)</label>
            <input
              type="number"
              value={durationSec}
              onChange={(e)=>setDurationSec(Math.max(1, Number(e.target.value || 1200)))}
              style={{ width:'100%' }}
              disabled={roundStatus==='RUNNING'}
            />
            <small style={{ color:'#888' }}>기본 1200초(20분). RUNNING 중엔 변경 불가.</small>
          </div>

          <div style={{ marginTop: 16, padding: 12, border:'1px solid #eee', borderRadius:8 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <b>라운드 상태</b>
              <span style={{ color, fontWeight:700 }}>{roundStatus}</span>
            </div>
            <div style={{ marginTop: 8, fontSize: 40, textAlign:'center', fontVariantNumeric:'tabular-nums' }}>
              {mmss}
            </div>
          </div>

          <div style={{ display:'grid', gap:8, gridTemplateColumns:'1fr 1fr 1fr', marginTop:16 }}>
            <button onClick={startRound} disabled={booting || !sessionId || roundStatus==='RUNNING'}>시작</button>
            <button onClick={stopRound}  disabled={booting || !sessionId || roundStatus!=='RUNNING'}>종료</button>
            <button onClick={createOrReadySession} disabled={booting || !sessionId || roundStatus==='RUNNING'}>READY</button>
          </div>

          <p style={{ color:'#888', marginTop:8 }}>{msg}</p>
        </div>

        {/* 🔹 오른쪽: 주식 / 부동산 시나리오 미리보기 */}
        <div style={{ flex: 1, minWidth: 360 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2>시나리오 미리보기</h2>
            <button
              onClick={refreshScenario}
              disabled={!sessionId || booting || roundStatus !== 'READY'}
            >
              시나리오 새로고침
            </button>
          </div>
          <small style={{ color: '#888' }}>
            10분 간격, 주식 기본: 50000, 부동산 기본: 200000, 매 구간 ± 랜덤 변동 (20분 기준 0·10분 총 2개 가격)
          </small>

          {/* 주식 시나리오 표 */}
          <h3 style={{ marginTop: 16 }}>주식</h3>
          {stockScenario.length === 0 ? (
            <p style={{ color: '#888' }}>시나리오가 없습니다. READY 버튼으로 세션을 개설하세요.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, marginTop: 4 }}>
              <thead>
                <tr>
                  <th style={{ border: '1px solid #444', padding: 4 }}>종목</th>
                  {timeLabels.map((t) => (
                    <th key={t} style={{ border: '1px solid #444', padding: 4 }}>{t}분</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stockScenario.map((asset) => (
                  <tr key={asset.name}>
                    <td style={{ border: '1px solid #444', padding: 4 }}>{asset.name}</td>
                    {asset.prices.map((p, idx) => (
                      <td key={idx} style={{ border: '1px solid #444', padding: 4, textAlign: 'right' }}>{p}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* 부동산 시나리오 표 */}
          <h3 style={{ marginTop: 16 }}>부동산</h3>
          {realEstateScenario.length === 0 ? (
            <p style={{ color: '#888' }}>시나리오가 없습니다.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, marginTop: 4 }}>
              <thead>
                <tr>
                  <th style={{ border: '1px solid #444', padding: 4 }}>자산</th>
                  {timeLabels.map((t) => (
                    <th key={t} style={{ border: '1px solid #444', padding: 4 }}>{t}분</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {realEstateScenario.map((asset) => (
                  <tr key={asset.name}>
                    <td style={{ border: '1px solid #444', padding: 4 }}>{asset.name}</td>
                    {asset.prices.map((p, idx) => (
                      <td key={idx} style={{ border: '1px solid #444', padding: 4, textAlign: 'right' }}>{p}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
