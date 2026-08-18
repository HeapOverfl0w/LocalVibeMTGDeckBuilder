import { NavLink } from 'react-router-dom';

interface NavbarProps {
  username: string;
  onLogout: () => void;
}

export default function Navbar({ username, onLogout }: NavbarProps) {
  return (
    <header className="header">
      <div className="header-left">
        <h1>⚔️ MTG Deck Builder</h1>
        <nav className="nav-tabs">
          <NavLink to="/community" className={({ isActive }) => (isActive ? 'active' : '')}>
            Community
          </NavLink>
          <NavLink to="/decks" className={({ isActive }) => (isActive ? 'active' : '')}>
            My Decks
          </NavLink>
        </nav>
      </div>
      <div className="header-right">
        <span className="user-badge">{username}</span>
        <button className="btn" onClick={onLogout}>Log out</button>
      </div>
    </header>
  );
}
