import React, { useState, useCallback } from 'react';
import './App.css';

import Home from './components/Home';
import Profile from './components/Profile';
import Community from './components/Community';
import Blog from './components/Blog';
import AboutUs from './components/AboutUs';
import Auth from './components/Auth';
import AdminPanel from './components/AdminPanel';
import Bookshelf from './components/Bookshelf';
import AiAssistant from './components/AiAssistant';

import { apiFetch } from './api';
import { useAutoLogout } from './hooks/useAutoLogout';

function App() {
  // --- STATE UNTUK OTENTIKASI ---
  // Sesi asli sekarang datang dari backend (sessionToken), bukan cuma tebak-tebakan localStorage.
  // Profil (nama/bio/avatar) tetap boleh di-cache di localStorage untuk kenyamanan tampilan,
  // tapi status LOGIN yang sebenarnya ditentukan oleh sessionToken yang valid di server.
  const [user, setUser] = useState(() => {
    const activeEmail = localStorage.getItem('rabuku_active_session');
    if (activeEmail) {
      const savedProfile = localStorage.getItem(`rabuku_profile_${activeEmail}`);
      return savedProfile ? JSON.parse(savedProfile) : null;
    }
    return null;
  });

  const [sessionToken, setSessionToken] = useState(() => localStorage.getItem('rabuku_session_token'));
  const [isAuthenticated, setIsAuthenticated] = useState(!!user && !!sessionToken);
  const [view, setView] = useState('home');
  const [aiOpen, setAiOpen] = useState(false); // 🟢 Ask AI sekarang dikontrol dari sini, dipicu dari navbar

  const handleLogout = useCallback(async (reason) => {
    const token = localStorage.getItem('rabuku_session_token');
    if (token) {
      // Beri tahu server juga, best-effort (kalau gagal karena sesi sudah habis duluan, tidak apa-apa)
      apiFetch('/api/logout', { method: 'POST' }, token).catch(() => {});
    }

    setIsAuthenticated(false);
    setUser(null);
    setSessionToken(null);
    setView('home');
    setAiOpen(false);
    localStorage.removeItem('rabuku_active_session');
    localStorage.removeItem('rabuku_session_token');

    if (reason) alert(`🔒 ${reason}`);
  }, []);

  function handleSessionExpired(message) {
    handleLogout(message || 'Sesi berakhir, silakan login lagi.');
  }

  // 🟢 apiFetch yang sudah "tahu" token sesi user saat ini + otomatis logout kalau sesi habis.
  const authedFetch = useCallback(
    (path, options) => apiFetch(path, options, sessionToken, handleSessionExpired),
    [sessionToken] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // 🟢 Auto-logout kalau user diam (idle) — sinkron dengan idle timeout di backend (.env SESSION_TIMEOUT_MINUTES)
  useAutoLogout(isAuthenticated, handleLogout, 15);

  // Dipanggil dari Auth.jsx setelah login/verifikasi OTP sukses.
  // userData wajib berisi { name, email, role, sessionToken }.
  const handleLogin = (userData) => {
    const savedProfile = localStorage.getItem(`rabuku_profile_${userData.email}`);
    const newUser = savedProfile
      ? { ...JSON.parse(savedProfile), role: userData.role } // role selalu ambil dari server, jangan dari cache lama
      : { name: userData.name, email: userData.email, role: userData.role, points: 100 };

    setUser(newUser);
    setSessionToken(userData.sessionToken);
    setIsAuthenticated(true);

    localStorage.setItem('rabuku_active_session', newUser.email);
    localStorage.setItem(`rabuku_profile_${newUser.email}`, JSON.stringify(newUser));
    if (userData.sessionToken) localStorage.setItem('rabuku_session_token', userData.sessionToken);
  };

  const handleUpdateProfile = (updatedUser) => {
    setUser(updatedUser);
    localStorage.setItem(`rabuku_profile_${updatedUser.email}`, JSON.stringify(updatedUser));
  };

  const renderContent = () => {
    switch (view) {
      case 'home': return <Home />;
      case 'bookshelf': return <Bookshelf user={user} apiFetch={authedFetch} />;
      case 'community': return <Community user={user} apiFetch={authedFetch} />;
      case 'blog': return <Blog apiFetch={authedFetch} />;
      case 'profile':
        return (
          <Profile
            user={user}
            apiFetch={authedFetch}
            onLogout={() => handleLogout()}
            onUpdateProfile={handleUpdateProfile}
          />
        );
      case 'aboutus': return <AboutUs />;
      case 'admin': return <AdminPanel apiFetch={authedFetch} />;
      default: return <Home />;
    }
  };

  if (!isAuthenticated) {
    return <Auth onLogin={handleLogin} />;
  }

  return (
    <div>
      <nav>
        <div className="logo">
          <img src="/book-loading.gif" alt="Logo" onClick={() => setView('home')} style={{ cursor: 'pointer' }} />
        </div>

        <ul>
          <li className={view === 'home' ? 'active' : ''} onClick={() => setView('home')}><a href="#">Home</a></li>
          <li className={view === 'bookshelf' ? 'active' : ''} onClick={() => setView('bookshelf')}><a href="#">Bookshelf</a></li>
          <li className={view === 'aboutus' ? 'active' : ''} onClick={() => setView('aboutus')}><a href="#">About Us</a></li>
          <li className={view === 'blog' ? 'active' : ''} onClick={() => setView('blog')}><a href="#">Blog</a></li>
          <li className={view === 'profile' ? 'active' : ''} onClick={() => setView('profile')}><a href="#">Profile</a></li>
          <li className={aiOpen ? 'active' : ''} onClick={() => setAiOpen(prev => !prev)}>
            <a href="#" style={{ color: '#000000' }}>✨Tanya AI</a>
          </li>

          {user && user.role === 'admin' && (
            <li className={view === 'admin' ? 'active' : ''} onClick={() => setView('admin')}>
              <a href="#" style={{ color: '#000000', fontWeight: 'bold' }}>Admin Panel</a>
            </li>
          )}
        </ul>

        <div className="social_icon" style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
          <a href="https://wa.me/6289637931319" target="_blank" rel="noopener noreferrer">
            <i className="fab fa-whatsapp"></i>
          </a>
          <i className="fa-solid fa-heart" onClick={() => setView('profile')} style={{ cursor: 'pointer' }}></i>

          <button onClick={() => handleLogout()} style={{ background: '#e74c3c', color: '#fff', border: 'none', padding: '5px 10px', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold' }}>
            Logout
          </button>
        </div>
      </nav>

      <main>
        {renderContent()}
      </main>

      {/* 🟢 Panel Ask AI, dikontrol dari navbar (bukan floating button lagi) */}
      <AiAssistant isOpen={aiOpen} onClose={() => setAiOpen(false)} />
    </div>
  );
}

export default App;
