import { Link, Route, Routes } from 'react-router-dom'
import Player from './pages/Player'
import Admin from './pages/Admin'
import Viewer from './pages/Viewer'
import InstallPWA from './components/InstallPWA'

export default function App() {
  return (
    <>
      <div style={{ padding: 24, color: '#fff' }}>
        <h1>MoneyVillage</h1>
        <nav style={{ display: 'flex', gap: 12 }}>
          <Link to="/">Home</Link>
          <Link to="/player">Player</Link>
          <Link to="/admin">Admin</Link>
          <Link to="/viewer">Viewer</Link>
        </nav>

        <Routes>
          <Route path="/" element={<div>Home OK</div>} />
          <Route path="/player" element={<Player />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/viewer" element={<Viewer />} />
        </Routes>
        
        <InstallPWA />
      </div>
    </>
  );
}
