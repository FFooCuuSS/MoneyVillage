// src/pages/Player.tsx
import { useEffect, useMemo, useState } from 'react';
import {
  addDoc,
  collection,
  serverTimestamp,
  query,
  where,
  limit,
  getDocs,
  doc,
  onSnapshot,
  setDoc,
  runTransaction,
} from 'firebase/firestore';
import { db, ensureAnon } from '../firebase';

const BOOTHS = [
  { id: 'labor',      label: '노동' },
  { id: 'bank',       label: '은행' },
  { id: 'stock',      label: '주식' },
  { id: 'realestate', label: '부동산' },
  { id: 'quest',      label: '퀘스트' },
  { id: 'luck',       label: '행운' },
  { id: 'group',      label: '단체게임' },
];

type RoundStatus = 'READY' | 'RUNNING' | 'ENDED';
type TradeTab = 'bank' | 'stock' | 'realestate' | 'quest' | null;
type BankProductType = 'SHORT' | 'MID' | 'LONG';
type ProductStatus = 'ACTIVE' | 'DONE' | 'CANCELED';

type AssetScenario = {
  name: string;
  prices: number[];
};
type BankProduct = {
  id: string;
  type: BankProductType;
  principal: number;
  multiplier: number;
  startedAt: number;
  matureAt: number;
  canceled: boolean;
  withdrawn: boolean;
};
const DEPOSIT_CONFIG: Record<BankProductType, {
  label: string;
  durationSec: number;
  multiplier: number;
}> = {
  SHORT: { label: '단기 (10분 / 1.5배)', durationSec: 600,  multiplier: 1.5 },
  MID:   { label: '중기 (15분 / 2배)', durationSec: 900, multiplier: 2.0 },
  LONG:  { label: '장기 (20분 / 2.5배)',   durationSec: 1200, multiplier: 2.5 },
};

const STEP_MIN = 10; // 10분 간격
const QUEST_REWARDS = [5, 5, 5, 10, 10, 15];

// 금액 입력으로만 처리하는 부스
const SIMPLE_BOOTHS = ['labor', 'luck', 'group'] as const;
type SimpleBoothId = (typeof SIMPLE_BOOTHS)[number];

function isSimpleBooth(id: string): id is SimpleBoothId {
  return SIMPLE_BOOTHS.includes(id as SimpleBoothId);
}

export default function Player() {
  const [loading, setLoading] = useState(true);
  const [sessionId, setSessionId] = useState('');
  const [userId, setUserId] = useState('');
  const [boothId, setBoothId] = useState(BOOTHS[0].id);
  const [amount, setAmount] = useState<number | ''>(10);
  const [msg, setMsg] = useState('');

  // 라운드 상태 구독
  const [roundStatus, setRoundStatus] = useState<RoundStatus>('READY');
  const [roundEndsAt, setRoundEndsAt] = useState<Date | null>(null);
  const [roundDurationSec, setRoundDurationSec] = useState(1200);
  const [remain, setRemain] = useState(0);

  const [activeTab, setActiveTab] = useState<TradeTab>(null);
  
  // 시나리오 / 부동산 소유
  const [stockScenario, setStockScenario] = useState<AssetScenario[]>([]);
  const [realEstateScenario, setRealEstateScenario] = useState<AssetScenario[]>([]);
  const [realEstateOwners, setRealEstateOwners] = useState<Record<string, string | null>>({});

  // 플레이어 자산 상태
  const [asset, setAsset] = useState(10000); // 현금
  const [stockHoldings, setStockHoldings] = useState<Record<string, number>>({});
  const [realEstateHoldings, setRealEstateHoldings] = useState<Record<string, boolean>>({});

  // 은행탭
  const [bankProducts, setBankProducts] = useState<BankProduct[]>([]);
  const [depositAmount, setDepositAmount] = useState<number | ''>(10000);

  // 퀘스트탭
  const [questSolved, setQuestSolved] = useState(false);
  const [questAnswers, setQuestAnswers] = useState<string[]>(Array(6).fill(''));

  // ==============================
  // 1) 세션 & 사용자 초기 설정
  // ==============================
  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const user = await ensureAnon();
        setUserId(user.uid);

        // 최신 OPEN 세션만 찾기
        const qy = query(
          collection(db, 'sessions'),
          where('status', '==', 'OPEN'),
          limit(1)
        );
        const snap = await getDocs(qy);
        if (!snap.empty) {
          setSessionId(snap.docs[0].id);
          setMsg('');
        } else {
          setSessionId('');
          setMsg('열린 세션이 없습니다. 관리자가 READY로 개설하세요.');
        }
      } catch (e) {
        console.error(e);
        setMsg('세션 초기화 실패');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // ==============================
  // 2) 세션 문서 구독
  // ==============================
  useEffect(() => {
    if (!sessionId) return;
    const unsub = onSnapshot(doc(db, 'sessions', sessionId), d => {
      const data = d.data();
      if (!data) return;
      setRoundStatus((data.roundStatus ?? 'READY') as RoundStatus);
      setRoundEndsAt(data.roundEndsAt ? data.roundEndsAt.toDate() : null);
      setRoundDurationSec(Number(data.roundDurationSec ?? 1200) || 1200);
      setStockScenario((data.stockScenario ?? []) as AssetScenario[]);
      setRealEstateScenario((data.realEstateScenario ?? []) as AssetScenario[]);
      setRealEstateOwners((data.realEstateOwners ?? {}) as Record<string, string | null>);
      
    });
    return () => unsub();
  }, [sessionId]);

  // ==============================
  // 3) 남은 시간 표시
  // ==============================
  useEffect(() => {
    let h: number | null = null;
    if (roundStatus === 'RUNNING' && roundEndsAt) {
      h = window.setInterval(() => {
        const s = Math.max(0, Math.floor((roundEndsAt.getTime() - Date.now()) / 1000));
        setRemain(s);
      }, 1000) as unknown as number;
    } else if (roundStatus === 'READY') {
      setRemain(roundDurationSec); // 아직 시작 안 했으면 전체 시간
    } else {
      setRemain(0);
    }
    return () => { if (h) window.clearInterval(h); };
  }, [roundStatus, roundEndsAt, roundDurationSec]);

  // ==============================
  // 4) 참가자(Participant) 자산 구독
  // ==============================
  useEffect(() => {
  if (!sessionId || !userId) return;

  const pid = `${sessionId}_${userId}`;
  const ref = doc(db, 'participants', pid);

  // 존재 여부 상관 없이 기본 필드 유지
  setDoc(ref, {
    sessionId,
    userId,
    asset: 150000,
    stockHoldings: {},
    realEstateHoldings: {},
  }, { merge: true }).catch(console.error);

  const unsub = onSnapshot(ref, d => {
    const data = d.data();
    if (!data) return;
    setAsset(Number(data.asset ?? 10000));
    setStockHoldings((data.stockHoldings ?? {}) as Record<string, number>);
    setRealEstateHoldings((data.realEstateHoldings ?? {}) as Record<string, boolean>);
    setBankProducts((data.bankProducts ?? []) as BankProduct[]);
    setQuestSolved(Boolean(data.questSolved ?? false));
    setQuestAnswers((data.questAnswers ?? Array(6).fill('')) as string[]);
  });

  return () => unsub();
}, [sessionId, userId]);

  // ==============================
  // 5) 부스 선택 ↔ 탭 동기화
  // ==============================
  // 부스에서 은행/주식/부동산을 고르면 오른쪽 탭 따라가게
  useEffect(() => {
    if (boothId === 'bank' || boothId === 'stock' || boothId === 'realestate' || boothId === 'quest') {
      setActiveTab(boothId as TradeTab);
    }
  }, [boothId]);


  // ==============================
  // 6) 현재 “단계” 계산 (0분, 10분, 20분...)
  // ==============================
  const currentStep = useMemo(() => {
    const anyScenario = stockScenario[0] || realEstateScenario[0];
    const maxSteps = anyScenario?.prices?.length ?? 1;
    if (maxSteps <= 1) return 0;

    // 경과 시간 = 전체 - 남은 시간
    const elapsed = (roundDurationSec || 0) - (remain || 0);
    const step = Math.floor(elapsed / (STEP_MIN * 60));
    const clamped = Math.min(Math.max(step, 0), maxSteps - 1);
    return clamped;
  }, [remain, roundDurationSec, stockScenario, realEstateScenario]);

  // ==============================
  // 7) 단순 부스용 거래 기록 (노동/퀘스트/행운)
  // ==============================
  async function saveSimpleBoothTransaction() {
  if (!sessionId || !userId) return;

  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    setMsg("금액은 0보다 커야 합니다.");
    return;
  }

  try {
    const pid = `${sessionId}_${userId}`;
    const partRef = doc(db, 'participants', pid);

    // 1) 참가자 자산 업데이트 (asset += amt)
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(partRef);
      const data = snap.data() || {};
      const curAsset = Number(data.asset ?? 10000);

      tx.set(
        partRef,
        {
          sessionId,
          userId,
          asset: curAsset + amt,
          stockHoldings: data.stockHoldings ?? {},
          realEstateHoldings: data.realEstateHoldings ?? {},
        },
        { merge: true }
      );
    });

    // 2) 거래 로그 남기기
    await addDoc(collection(db, 'transactions'), {
      sessionId,
      userId,
      boothId,
      amount: amt,
      createdAt: serverTimestamp(),
    });

    setMsg('저장 완료');
    setAmount('');
  } catch (e: any) {
    console.error(e);
    setMsg(`저장 실패: ${e?.message ?? String(e)}`);
  }
}

  const saveDisabled = useMemo(
  () =>
    loading ||
    !sessionId ||
    !boothId ||
    !isSimpleBooth(boothId) ||
    !Number.isFinite(Number(amount)) ||
    roundStatus !== 'RUNNING',
  [loading, sessionId, boothId, amount, roundStatus]
);


  // ==============================
  // 8) 주식 / 부동산 매수·매도
  // ==============================
  const participantId = useMemo(
    () => (sessionId && userId ? `${sessionId}_${userId}` : ''),
    [sessionId, userId]
  );

  async function buyStock(name: string, price: number) {
  try {
    if (!sessionId || !participantId) throw new Error('세션 없음');
    if (roundStatus !== 'RUNNING') throw new Error('라운드 중에만 거래 가능합니다.');
    if (asset < price) throw new Error('자산이 부족합니다.');

    // 🔥 추가: 현재 보유량 확인 (5개 제한)
    const currentHold = stockHoldings[name] ?? 0;
    if (currentHold >= 5) {
      throw new Error('이 종목은 최대 5개까지만 보유할 수 있습니다.');
    }

    const partRef = doc(db, 'participants', participantId);

    await runTransaction(db, async (tx) => {
      const snap = await tx.get(partRef);
      const data = snap.data() || {};

      const curAsset = Number(data.asset ?? 10000);
      if (curAsset < price) throw new Error('자산이 부족합니다.');

      const stocks: Record<string, number> = { ...(data.stockHoldings ?? {}) };

      // 🔥 중복 안전장치 (트랜잭션 내부에서도 체크)
      const cur = stocks[name] ?? 0;
      if (cur >= 5) {
        throw new Error('이 종목은 최대 5개까지만 보유할 수 있습니다.');
      }

      stocks[name] = cur + 1;

      tx.set(partRef, {
        sessionId,
        userId,
        asset: curAsset - price,
        stockHoldings: stocks,
      }, { merge: true });
    });

    setMsg(`${name} 1주 매수 완료`);
  } catch (e:any) {
    console.error(e);
    setMsg(e?.message ?? '주식 매수 실패');
  }
}

  async function sellStock(name: string, price: number) {
    try {
      if (!sessionId || !participantId) throw new Error('세션 없음');
      if (roundStatus !== 'RUNNING') throw new Error('라운드 중에만 거래 가능합니다.');
      if ((stockHoldings[name] ?? 0) <= 0) throw new Error('보유 수량이 없습니다.');

      const partRef = doc(db, 'participants', participantId);

      await runTransaction(db, async (tx) => {
        const snap = await tx.get(partRef);
        const data = snap.data() || {};
        const stocks: Record<string, number> = { ...(data.stockHoldings ?? {}) };
        const cur = stocks[name] ?? 0;
        if (cur <= 0) throw new Error('보유 수량이 없습니다.');

        const curAsset = Number(data.asset ?? 10000);

        stocks[name] = cur - 1;

        tx.set(partRef, {
          sessionId,
          userId,
          asset: curAsset + price,
          stockHoldings: stocks,
        }, { merge: true });
      });

      setMsg(`${name} 1주 매도 완료`);
    } catch (e:any) {
      console.error(e);
      setMsg(e?.message ?? '주식 매도 실패');
    }
  }

  async function buyRealEstate(name: string, price: number) {
    try {
      if (!sessionId || !participantId) throw new Error('세션 없음');
      if (roundStatus !== 'RUNNING') throw new Error('라운드 중에만 거래 가능합니다.');

      const sessionRef = doc(db, 'sessions', sessionId);
      const partRef = doc(db, 'participants', participantId);

      await runTransaction(db, async (tx) => {
        const [sSnap, pSnap] = await Promise.all([
          tx.get(sessionRef),
          tx.get(partRef),
        ]);

        const sData = sSnap.data() || {};
        const owners: Record<string, string | null> = { ...(sData.realEstateOwners ?? {}) };

        if (owners[name] && owners[name] !== userId) {
          throw new Error('이미 다른 참가자가 구매한 매물입니다.');
        }

        const pData = pSnap.data() || {};
        const curAsset = Number(pData.asset ?? 10000);
        if (curAsset < price) throw new Error('자산이 부족합니다.');

        const holdings: Record<string, boolean> = { ...(pData.realEstateHoldings ?? {}) };

        owners[name] = userId;
        holdings[name] = true;

        tx.set(sessionRef, { realEstateOwners: owners }, { merge: true });
        tx.set(partRef, {
          sessionId,
          userId,
          asset: curAsset - price,
          realEstateHoldings: holdings,
        }, { merge: true });
      });

      setMsg(`${name} 매입 완료`);
    } catch (e:any) {
      console.error(e);
      setMsg(e?.message ?? '부동산 매입 실패');
    }
  }

  async function sellRealEstate(name: string, price: number) {
    try {
      if (!sessionId || !participantId) throw new Error('세션 없음');
      if (roundStatus !== 'RUNNING') throw new Error('라운드 중에만 거래 가능합니다.');

      const sessionRef = doc(db, 'sessions', sessionId);
      const partRef = doc(db, 'participants', participantId);

      await runTransaction(db, async (tx) => {
        const [sSnap, pSnap] = await Promise.all([
          tx.get(sessionRef),
          tx.get(partRef),
        ]);

        const sData = sSnap.data() || {};
        const owners: Record<string, string | null> = { ...(sData.realEstateOwners ?? {}) };

        if (owners[name] !== userId) {
          throw new Error('이 매물의 소유자가 아닙니다.');
        }

        const pData = pSnap.data() || {};
        const holdings: Record<string, boolean> = { ...(pData.realEstateHoldings ?? {}) };

        if (!holdings[name]) throw new Error('보유 중인 매물이 아닙니다.');

        const curAsset = Number(pData.asset ?? 10000);

        owners[name] = null;
        holdings[name] = false;

        tx.set(sessionRef, { realEstateOwners: owners }, { merge: true });
        tx.set(partRef, {
          sessionId,
          userId,
          asset: curAsset + price,
          realEstateHoldings: holdings,
        }, { merge: true });
      });

      setMsg(`${name} 매도 완료`);
    } catch (e:any) {
      console.error(e);
      setMsg(e?.message ?? '부동산 매도 실패');
    }
  }
// ==============================
// 9) 은행 탭
// ==============================
    async function createBankProduct(type: BankProductType, principal: number) {
    if (!sessionId || !participantId) return;
    if (roundStatus !== 'RUNNING') {
      setMsg('라운드 중에만 가능합니다.');
      return;
    }

    const amtNum = Number(principal);
    if (!Number.isFinite(amtNum) || amtNum <= 0) {
      setMsg('투자 금액은 0보다 커야 합니다.');
      return;
    }

    if (asset < amtNum) {
      setMsg('자산이 부족합니다.');
      return;
    }

    const partRef = doc(db, 'participants', participantId);

    const multiplier =
      type === 'SHORT' ? 1.5 :
      type === 'MID'   ? 2.0 :
                         2.5;

    const durationMin =
      type === 'SHORT' ? 10 :
      type === 'MID'   ? 15 :
                         20;

    const now = Date.now();
    const matureAt = now + durationMin * 60 * 1000;

    const newProduct: BankProduct = {
      id: crypto.randomUUID(),
      type,
      principal: amtNum,
      multiplier,
      startedAt: now,
      matureAt,
      canceled: false,
      withdrawn: false,
    };

    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(partRef);
        const data = snap.data() || {};

        const curAsset = Number(data.asset ?? 10000);
        if (curAsset < amtNum) throw new Error('자산 부족');

        const list: BankProduct[] = (data.bankProducts ?? []) as BankProduct[];
        list.push(newProduct);

        tx.set(partRef, {
          asset: curAsset - amtNum,
          bankProducts: list,
          sessionId,
          userId,
        }, { merge: true });
      });

      setMsg('예금 신청 완료');
      setDepositAmount('');   // 입력창 리셋(선택사항)
    } catch (e: any) {
      console.error(e);
      setMsg(e.message ?? '예금 실패');
    }
  }


async function cancelBankProduct(id: string) {
  if (!sessionId || !participantId) return;

  const partRef = doc(db, 'participants', participantId);

  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(partRef);
      const data = snap.data() || {};

      const list: BankProduct[] = (data.bankProducts ?? []) as BankProduct[];
      const idx = list.findIndex(p => p.id === id);
      if (idx === -1) throw new Error('상품 없음');

      const prod = list[idx];
      if (prod.canceled || prod.withdrawn) throw new Error('이미 종료된 상품');

      // 중단 → 원금 그대로 돌려주기
      const curAsset = Number(data.asset ?? 10000);
      const newAsset = curAsset + prod.principal;

      // 상품 상태 업데이트
      list[idx] = { ...prod, canceled: true };

      tx.set(partRef, {
        asset: newAsset,
        bankProducts: list
      }, { merge: true });
    });

    setMsg('예금 해지 완료');
  } catch (e: any) {
    console.error(e);
    setMsg(e.message ?? '해지 실패');
  }
}

async function withdrawBankProduct(id: string) {
  if (!sessionId || !participantId) return;

  const partRef = doc(db, 'participants', participantId);

  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(partRef);
      const data = snap.data() || {};

      const list: BankProduct[] = (data.bankProducts ?? []) as BankProduct[];
      const idx = list.findIndex(p => p.id === id);
      if (idx === -1) throw new Error('상품 없음');

      const prod = list[idx];
      if (prod.canceled || prod.withdrawn) throw new Error('이미 종료한 상품');

      const now = Date.now();
      if (now < prod.matureAt) throw new Error('아직 만기 아님');

      const reward = Math.floor(prod.principal * prod.multiplier);

      const curAsset = Number(data.asset ?? 10000);

      list[idx] = { ...prod, withdrawn: true };

      tx.set(partRef, {
        asset: curAsset + reward,
        bankProducts: list
      }, { merge: true });
    });

    setMsg('만기 수령 완료');
  } catch (e: any) {
    console.error(e);
    setMsg(e.message ?? '수령 실패');
  }
}

  useEffect(() => {
    if (!participantId) return;
    if (bankProducts.length === 0) return;

    const timer = window.setInterval(() => {
      const now = Date.now();
      bankProducts.forEach(p => {
        if (!p.canceled && !p.withdrawn && now >= p.matureAt) {
          withdrawBankProduct(p.id);   // 만기되면 자동 수령
        }
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [participantId, bankProducts]);

  // ==============================
  // 10) 퀘스트 탭
  // ==============================

  async function submitQuestAnswers() {
  if (!sessionId || !participantId) {
    console.log("❌ sessionId 또는 participantId 없음 -> return");
    setMsg("세션/플레이어 ID 없음");
    return;
  }

  if (roundStatus !== 'RUNNING') {
    console.log("❌ roundStatus !== RUNNING -> return");
    setMsg("라운드가 RUNNING이 아님");
    return;
  }

  if (questSolved) {
    console.log("❌ questSolved=true -> return");
    setMsg("이미 퀘스트를 완료했습니다.");
    return;
  }

  // 정답 체크 (정답은 "정답")
  const correct = questAnswers.map(ans => ans.trim() === '정답');

  // 총 보상 계산
  let totalReward = 0;
  correct.forEach((ok, idx) => {
    if (ok) totalReward += QUEST_REWARDS[idx] * 10000; // 만원 단위
  });

  const partRef = doc(db, 'participants', participantId);

  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(partRef);
      const data = snap.data() || {};

      const curAsset = Number(data.asset ?? 10000);

      tx.set(
        partRef,
        {
          asset: curAsset + totalReward,
          questSolved: true,        // 🔥 세션당 1회 제한
          questAnswers: questAnswers,
          sessionId,
          userId
        },
        { merge: true }
      );
    });

    setMsg(`퀘스트 제출 완료! 보상: ${totalReward.toLocaleString()}원`);
  } catch (e:any) {
    console.error(e);
    setMsg(e?.message ?? '퀘스트 제출 실패');
  }
}


  // ==============================
  // 11) UI 렌더링
  // ==============================
  const mm = Math.floor(remain / 60);
  const ss = (remain % 60).toString().padStart(2, '0');

  return (
    <div style={{ padding: 20 }}>
      <h1>Player 입력폼</h1>

      <div style={{ marginTop: 4, color: '#bbb' }}>
        자산: {asset.toLocaleString()}원
        {' / '}
        상태: {roundStatus}
        {roundStatus === 'RUNNING' && ` (남은 시간 ${mm}:${ss})`}
      </div>

      {/* 좌우 2컬럼 레이아웃 */}
      <div style={{ display: 'flex', gap: 32, alignItems: 'flex-start', marginTop: 16 }}>
        {/* 왼쪽: 기본 입력 폼 */}
        <div style={{ maxWidth: 480, width: '100%' }}>
          <div style={{ marginTop: 12 }}>
            <label>세션 ID</label>
            <input value={sessionId} onChange={(e) => setSessionId(e.target.value)} style={{ width: '100%' }} />
            <small style={{ color: '#888' }}>OPEN 세션 자동 연결. 필요 시 수동 변경 가능</small>
          </div>

          {/* 여기 게임용 ID UI는 네가 쓰던 버전 그대로 둬도 됨 */}

          <div style={{ marginTop: 12 }}>
            <label>부스 선택</label>
            <select
              value={boothId}
              onChange={(e) => {
                const id = e.target.value as typeof BOOTHS[number]['id'];
                setBoothId(id);

                // 은행/주식/부동산이면 오른쪽 패널 켜고
                if (id === 'bank' || id === 'stock' || id === 'realestate') {
                  setActiveTab(id);           // 여기서 id는 TradeTab
                } else {
                  // 노동/퀘스트/행운이면 오른쪽 패널 숨김
                  setActiveTab(null);
                }
              }}
              style={{ width: '100%' }}
            >
              {BOOTHS.map((b) => (
                <option key={b.id} value={b.id}>{b.label}</option>
              ))}
            </select>
          </div>

          {/* 🔹 노동 / 퀘스트 / 행운에서만 금액 + 일반 저장 */}
          {isSimpleBooth(boothId) && (
            <>
              <div style={{ marginTop: 12 }}>
                <label>금액</label>
                <input
                  type="number"
                  min={0}
                  value={amount}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (v < 0) {
                      setAmount(0); // 음수 입력 즉시 0으로 보정
                    } else {
                      setAmount(Number.isFinite(v) ? v : 0);
                    }
                  }}
                  style={{ width: '100%' }}
                />
              </div>

              <button
                disabled={saveDisabled}
                onClick={saveSimpleBoothTransaction}
                style={{ marginTop: 16, width: '100%', height: 40 }}
              >
                Firestore 저장 (노동/퀘스트/행운용)
              </button>
            </>
          )}

          <p style={{ color: '#888', marginTop: 8 }}>{msg}</p>
        </div>

        {/* 오른쪽: 은행/주식/부동산 탭 영역 */}
        {activeTab && (
        <div style={{ flex: 1, minWidth: 320 }}>
          <h2>거래 상세</h2>

          <div style={{ border: '1px solid #444', borderRadius: 8, padding: 16, minHeight: 200 }}>
            {activeTab === 'bank' && (
            <>
              <p style={{ fontWeight: 'bold', marginBottom: 8 }}>예금 상품</p>

              {/* 신규 상품 가입 영역 */}
              <div style={{ marginBottom: 12 }}>
                <label>투자 금액</label>
                <input
                  type="number"
                  value={depositAmount}
                  onChange={(e) =>
                    setDepositAmount(e.target.value === '' ? '' : Number(e.target.value))
                  }
                  style={{ width: '100%', marginTop: 4 }}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button
                    disabled={
                      roundStatus !== 'RUNNING' ||
                      !Number.isFinite(Number(depositAmount)) ||
                      Number(depositAmount) <= 0 ||
                      asset < Number(depositAmount)
                    }
                    onClick={() => createBankProduct('SHORT', Number(depositAmount))}
                  >
                    단기 (10분 / 1.5배)
                  </button>
                  <button
                    disabled={
                      roundStatus !== 'RUNNING' ||
                      !Number.isFinite(Number(depositAmount)) ||
                      Number(depositAmount) <= 0 ||
                      asset < Number(depositAmount)
                    }
                    onClick={() => createBankProduct('MID', Number(depositAmount))}
                  >
                    중기 (15분 / 2배)
                  </button>
                  <button
                    disabled={
                      roundStatus !== 'RUNNING' ||
                      !Number.isFinite(Number(depositAmount)) ||
                      Number(depositAmount) <= 0 ||
                      asset < Number(depositAmount)
                    }
                    onClick={() => createBankProduct('LONG', Number(depositAmount))}
                  >
                    장기 (20분 / 2.5배)
                  </button>
                </div>
                <small style={{ color: '#888' }}>
                  하나 신청하면 위에서 또 입력해서 계속 추가할 수 있음.
                </small>
              </div>

              {/* 가입된 상품 목록 */}
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <thead>
                  <tr>
                    <th style={{ border: '1px solid #444', padding: 4 }}>종류</th>
                    <th style={{ border: '1px solid #444', padding: 4 }}>금액</th>
                    <th style={{ border: '1px solid #444', padding: 4 }}>남은 시간</th>
                    <th style={{ border: '1px solid #444', padding: 4 }}>행동</th>
                  </tr>
                </thead>
                <tbody>
                  {bankProducts
                    .filter(p => !p.canceled && !p.withdrawn)   // 끝난 건 자동으로 안 보이게
                    .map(p => {
                      const now = Date.now();
                      const cfgLabel =
                        p.type === 'SHORT'
                          ? '단기'
                          : p.type === 'MID'
                          ? '중기'
                          : '장기';
                      const remainSec = Math.max(
                        0,
                        Math.floor((p.matureAt - now) / 1000)
                      );
                      const isMature = remainSec === 0;

                      return (
                        <tr key={p.id}>
                          <td style={{ border: '1px solid #444', padding: 4 }}>
                            {cfgLabel}
                          </td>
                          <td
                            style={{
                              border: '1px solid #444',
                              padding: 4,
                              textAlign: 'right',
                            }}
                          >
                            {p.principal.toLocaleString()}
                          </td>
                          <td
                            style={{
                              border: '1px solid #444',
                              padding: 4,
                              textAlign: 'center',
                            }}
                          >
                            {isMature ? '만기' : `${remainSec}s`}
                          </td>
                          <td style={{ border: '1px solid #444', padding: 4 }}>
                            {/* 만기 전엔 중단 버튼만, 만기 후엔 수동 수령 버튼도 선택지로 둠 */}
                            {!isMature && (
                              <button onClick={() => cancelBankProduct(p.id)}>
                                중단
                              </button>
                            )}
                            {isMature && (
                              <button onClick={() => withdrawBankProduct(p.id)}>
                                수령
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  {bankProducts.filter(p => !p.canceled && !p.withdrawn).length === 0 && (
                    <tr>
                      <td
                        colSpan={4}
                        style={{
                          padding: 8,
                          textAlign: 'center',
                          color: '#888',
                          border: '1px solid #444',
                        }}
                      >
                        진행 중인 예금 상품이 없습니다.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </>
          )}


            
        
            {activeTab === 'stock' && (
              <>
                <p style={{ color: '#aaa' }}>
                  현재 단계: {currentStep} (4분 간격 시나리오 기준 가격)
                </p>
                {stockScenario.length === 0 ? (
                  <p style={{ color: '#888' }}>시나리오가 없습니다. 관리자에게 문의하세요.</p>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, marginTop: 4 }}>
                    <thead>
                      <tr>
                        <th style={{ border: '1px solid #444', padding: 4 }}>종목</th>
                        <th style={{ border: '1px solid #444', padding: 4 }}>현재가</th>
                        <th style={{ border: '1px solid #444', padding: 4 }}>보유수량</th>
                        <th style={{ border: '1px solid #444', padding: 4 }}>매수</th>
                        <th style={{ border: '1px solid #444', padding: 4 }}>매도</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stockScenario.map((assetRow) => {
                        const price = assetRow.prices[currentStep] ?? assetRow.prices[assetRow.prices.length - 1];
                        const hold = stockHoldings[assetRow.name] ?? 0;
                        const canBuy = roundStatus === 'RUNNING' && asset >= price;
                        const canSell = roundStatus === 'RUNNING' && hold > 0;
                        return (
                          <tr key={assetRow.name}>
                            <td style={{ border: '1px solid #444', padding: 4 }}>{assetRow.name}</td>
                            <td style={{ border: '1px solid #444', padding: 4, textAlign: 'right' }}>{price}</td>
                            <td style={{ border: '1px solid #444', padding: 4, textAlign: 'right' }}>{hold}</td>
                            <td style={{ border: '1px solid #444', padding: 4 }}>
                              <button
                                disabled={!canBuy}
                                onClick={() => buyStock(assetRow.name, price)}
                              >
                                매수
                              </button>
                            </td>
                            <td style={{ border: '1px solid #444', padding: 4 }}>
                              <button
                                disabled={!canSell}
                                onClick={() => sellStock(assetRow.name, price)}
                              >
                                매도
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </>
            )}

            {activeTab === 'realestate' && (
              <>
                <p style={{ color: '#aaa' }}>
                  현재 단계: {currentStep} (4분 간격 시나리오 기준 가격)
                </p>
                {realEstateScenario.length === 0 ? (
                  <p style={{ color: '#888' }}>시나리오가 없습니다. 관리자에게 문의하세요.</p>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, marginTop: 4 }}>
                    <thead>
                      <tr>
                        <th style={{ border: '1px solid #444', padding: 4 }}>매물</th>
                        <th style={{ border: '1px solid #444', padding: 4 }}>현재가</th>
                        <th style={{ border: '1px solid #444', padding: 4 }}>소유자</th>
                        <th style={{ border: '1px solid #444', padding: 4 }}>매수</th>
                        <th style={{ border: '1px solid #444', padding: 4 }}>매도</th>
                      </tr>
                    </thead>
                    <tbody>
                      {realEstateScenario.map((assetRow) => {
                        const price = assetRow.prices[currentStep] ?? assetRow.prices[assetRow.prices.length - 1];
                        const owner = realEstateOwners[assetRow.name] ?? null;
                        const iOwn = owner === userId || realEstateHoldings[assetRow.name];
                        const canBuy =
                          roundStatus === 'RUNNING' &&
                          !owner &&
                          asset >= price;
                        const canSell =
                          roundStatus === 'RUNNING' &&
                          iOwn;

                        return (
                          <tr key={assetRow.name}>
                            <td style={{ border: '1px solid #444', padding: 4 }}>{assetRow.name}</td>
                            <td style={{ border: '1px solid #444', padding: 4, textAlign: 'right' }}>{price}</td>
                            <td style={{ border: '1px solid #444', padding: 4 }}>
                              {owner ? (owner === userId ? '나' : owner.slice(0, 6) + '...') : '-'}
                            </td>
                            <td style={{ border: '1px solid #444', padding: 4 }}>
                              <button
                                disabled={!canBuy}
                                onClick={() => buyRealEstate(assetRow.name, price)}
                              >
                                매수
                              </button>
                            </td>
                            <td style={{ border: '1px solid #444', padding: 4 }}>
                              <button
                                disabled={!canSell}
                                onClick={() => sellRealEstate(assetRow.name, price)}
                              >
                                매도
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </>
            )}

            {activeTab === 'quest' && (
              <>
                <h3>퀘스트 문제</h3>

                {/* 세션당 1회 제한 (⚠️ 필요시 제거 가능) */}
                {questSolved && (
                  <p style={{ color: '#0f0', marginBottom: 12 }}>
                    이미 퀘스트를 완료했습니다. (세션당 1회)
                  </p>
                )}

                {!questSolved && (
                  <>
                    <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 12 }}>
                      <thead>
                        <tr>
                          <th style={{ border: '1px solid #444', padding: 4 }}>문제 번호</th>
                          <th style={{ border: '1px solid #444', padding: 4 }}>문제 내용</th>
                          <th style={{ border: '1px solid #444', padding: 4 }}>정답 입력</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[0,1,2,3,4,5].map(i => (
                          <tr key={i}>
                            <td style={{ border: '1px solid #444', padding: 4 }}>{i+1}</td>
                            <td style={{ border: '1px solid #444', padding: 4 }}>
                              랜덤한 문제 {i+1}이 출제되었습니다.
                            </td>
                            <td style={{ border: '1px solid #444', padding: 4 }}>
                              <input
                                value={questAnswers[i]}
                                onChange={(e) => {
                                  const newAns = [...questAnswers];
                                  newAns[i] = e.target.value;
                                  setQuestAnswers(newAns);
                                }}
                                placeholder='정답 입력'
                                style={{ width: '100%' }}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    <button
                      onClick={submitQuestAnswers}
                      disabled={roundStatus !== 'RUNNING'}
                      style={{ width: '100%', height: 40 }}
                    >
                      퀘스트 제출하기
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </div>
        )}
      </div>
    </div>
  );
}
