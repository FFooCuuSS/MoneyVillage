import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import type { User } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getAnalytics } from "firebase/analytics";

type FirebaseWebConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
  measurementId?: string;
};

const firebaseConfig: FirebaseWebConfig = {
  apiKey: "AIzaSyAyfQ9shg9F6cPhd4RsWjiohUSiLacKL2Q",
  authDomain: "moneyvillage-a82cf.firebaseapp.com",
  projectId: "moneyvillage-a82cf",
  storageBucket: "moneyvillage-a82cf.firebasestorage.app",
  messagingSenderId: "81839336532",
  appId: "1:81839336532:web:9e73f3ab5857848fddd1c1",
  measurementId: "G-JT9JWPXY5T",
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

export const analytics =
  typeof window !== "undefined" && firebaseConfig.measurementId
    ? getAnalytics(app)
    : undefined;

// 로그인 보장 + User 반환
export async function ensureAnon(): Promise<User> {
  if (auth.currentUser) return auth.currentUser;
  const cred = await signInAnonymously(auth);
  return cred.user;
}
