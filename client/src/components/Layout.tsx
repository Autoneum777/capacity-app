import {
  ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { AppSection } from '../context/ScenarioModeContext';
import { scenarioNavQuery, useScenarioMode } from '../context/ScenarioModeContext';
import { useContractVolumes } from '../context/ContractVolumesContext';
import { useI18n } from '../context/I18nContext';
import { useAuth } from '../context/AuthContext';
import { useOcuMode } from '../context/OcuModeContext';
import LanguageSwitcher from './LanguageSwitcher';
import UserMenu from './UserMenu';
import CallOffNewComparisonControl from './callOffs/CallOffNewComparisonControl';
import ScenarioNewControl from './scenarios/ScenarioNewControl';
import {
  DEFAULT_WORKSPACE_THEMES,
  workspaceAccentMuted,
  workspaceBannerGradient,
  workspaceThemesFromVisualSettings,
  type WorkspaceThemeColors,
  type WorkspaceThemeSettings,
} from '../utils/workspaceTheme';

type HeaderCollapse = 'none' | 'right' | 'both';

function HeaderMenuToggle({
  label,
  open,
  onToggle,
  accentColor,
  icon,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  accentColor: string;
  icon: 'nav' | 'tools';
}) {
  return (
    <button
      type="button"
      className="app-header-menu-toggle"
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open}
      title={label}
      onClick={onToggle}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height: 32,
        minWidth: 44,
        padding: '0 10px',
        border: `2px solid ${accentColor}`,
        borderRadius: 8,
        background: open ? '#f0f4f8' : '#fff',
        color: accentColor,
        cursor: 'pointer',
        flexShrink: 0,
        fontSize: 13,
        fontWeight: 600,
      }}
    >
      {icon === 'nav' ? (
        <svg viewBox="0 0 24 24" width={18} height={18} fill="currentColor" aria-hidden>
          <path d="M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width={18} height={18} fill="currentColor" aria-hidden>
          <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />
        </svg>
      )}
    </button>
  );
}

function HeaderOverflowMenu({
  label,
  open,
  onToggle,
  onClose,
  accentColor,
  icon,
  align = 'right',
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  accentColor: string;
  icon: 'nav' | 'tools';
  align?: 'left' | 'right';
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  return (
    <div ref={rootRef} style={{ position: 'relative', flexShrink: 0 }}>
      <HeaderMenuToggle label={label} open={open} onToggle={onToggle} accentColor={accentColor} icon={icon} />
      {open ? (
        <div
          role="menu"
          className="app-header-overflow-panel"
          style={{
            position: 'absolute',
            top: '100%',
            [align]: 0,
            marginTop: 6,
            minWidth: 240,
            maxWidth: 'min(92vw, 360px)',
            maxHeight: 'min(70vh, 520px)',
            overflowY: 'auto',
            padding: 10,
            background: '#fff',
            border: `1px solid ${accentColor}`,
            borderRadius: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,0.14)',
            zIndex: 260,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 700, color: '#666', textTransform: 'uppercase', letterSpacing: 0.3 }}>
            {label}
          </div>
          {children}
        </div>
      ) : null}
    </div>
  );
}

async function pickLatestCallOff(): Promise<{ id: number; name: string } | null> {
  const list = await api.callOffs.list({ archived: false });
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => {
    const ta = new Date(a.updated_at || a.created_at || 0).getTime();
    const tb = new Date(b.updated_at || b.created_at || 0).getTime();
    return tb - ta;
  });
  const pick = sorted[0];
  return pick ? { id: pick.id, name: pick.name } : null;
}

async function pickLatestScenario(): Promise<{ id: number; name: string } | null> {
  const list = await api.scenarios.list({ archived: false });
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => {
    const ta = new Date(a.updated_at || a.created_at || 0).getTime();
    const tb = new Date(b.updated_at || b.created_at || 0).getTime();
    return tb - ta;
  });
  const pick = sorted[0];
  return pick ? { id: pick.id, name: pick.name } : null;
}

function MainNavLink({
  path,
  label,
  end,
  appSection,
  activeScenarioId,
  setActiveScenario,
  navigate,
  navTheme,
  isActivePath,
  menu = false,
  onNavigate,
}: {
  path: string;
  label: string;
  end?: boolean;
  appSection: AppSection;
  activeScenarioId: number | null;
  setActiveScenario: (id: number, name: string) => void;
  navigate: ReturnType<typeof useNavigate>;
  navTheme: WorkspaceThemeColors;
  isActivePath?: (pathname: string) => boolean;
  menu?: boolean;
  onNavigate?: () => void;
}) {
  const location = useLocation();
  const navInactive = workspaceAccentMuted(navTheme.accent);
  const needsScenarioPick =
    appSection === 'scenarios' && path !== '/scenariusze' && (activeScenarioId == null || activeScenarioId <= 0);
  const to =
    appSection === 'capacity'
      ? path
      : appSection === 'calloffs'
        ? path
        : path === '/scenariusze'
          ? path
          : activeScenarioId != null && activeScenarioId > 0
            ? `${path}?scenarioId=${activeScenarioId}`
            : path;

  return (
    <NavLink
      to={to}
      end={end}
      className={menu ? 'app-header-menu-link' : undefined}
      onClick={async (e) => {
        if (!needsScenarioPick) {
          onNavigate?.();
          return;
        }
        e.preventDefault();
        const pick = await pickLatestScenario();
        if (!pick) {
          navigate('/scenariusze');
          onNavigate?.();
          return;
        }
        setActiveScenario(pick.id, pick.name);
        navigate(`${path}?scenarioId=${pick.id}`);
        onNavigate?.();
      }}
      style={({ isActive }) => {
        const active = isActivePath ? isActivePath(location.pathname) : isActive;
        return {
          display: menu ? 'block' : undefined,
          width: menu ? '100%' : undefined,
          boxSizing: 'border-box' as const,
          padding: menu ? '0.55rem 0.75rem' : '0.5rem 0.75rem',
          color: active ? '#fff' : navInactive,
          textDecoration: 'none',
          borderRadius: 4,
          background: active ? navTheme.accent : 'transparent',
          whiteSpace: 'nowrap' as const,
        };
      }}
    >
      {label}
    </NavLink>
  );
}

export default function Layout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    activeScenarioId,
    activeScenarioName,
    activeCallOffId,
    activeCallOffName,
    setActiveScenario,
    clearActiveScenario,
    setActiveCallOff,
    clearActiveCallOff,
    setAppSection,
    appSection,
  } = useScenarioMode();
  const { useContractualVolumes, setUseContractualVolumes } = useContractVolumes();
  const { t } = useI18n();
  const { hasPermission, hasAnyPermission } = useAuth();
  const { ocuFeatureEnabled, calculationProfile, toggleCalculationProfile } = useOcuMode();
  const [contractualFrameColor, setContractualFrameColor] = useState('#ff9800');
  const [workspaceThemes, setWorkspaceThemes] = useState<WorkspaceThemeSettings>(DEFAULT_WORKSPACE_THEMES);
  const [headerCollapse, setHeaderCollapse] = useState<HeaderCollapse>('none');
  const [navMenuOpen, setNavMenuOpen] = useState(false);
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const brandRef = useRef<HTMLSpanElement>(null);
  const navMeasureRef = useRef<HTMLElement>(null);
  const toolsMeasureRef = useRef<HTMLDivElement>(null);
  const trailingMeasureRef = useRef<HTMLDivElement>(null);

  const loadVisualPrefs = useCallback(() => {
    api.settings.visual
      .get()
      .then((v) => {
        const raw = v as { contractual_calculator_frame_color?: string };
        const c = raw?.contractual_calculator_frame_color;
        if (typeof c === 'string' && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(c.trim())) {
          setContractualFrameColor(c.trim());
        }
        setWorkspaceThemes(workspaceThemesFromVisualSettings(v as Record<string, unknown>));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadVisualPrefs();
    let lastAt = 0;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastAt < 45_000) return;
      lastAt = now;
      loadVisualPrefs();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loadVisualPrefs]);

  useEffect(() => {
    if (activeScenarioId == null || activeScenarioId <= 0 || activeScenarioName) return;
    api.scenarios
      .get(activeScenarioId)
      .then((s) => setActiveScenario(s.id, s.name))
      .catch(() => {});
  }, [activeScenarioId, activeScenarioName, setActiveScenario]);

  useEffect(() => {
    if (activeCallOffId == null || activeCallOffId <= 0 || activeCallOffName) return;
    api.callOffs
      .get(activeCallOffId)
      .then((c) => setActiveCallOff(c.id, c.name))
      .catch(() => {});
  }, [activeCallOffId, activeCallOffName, setActiveCallOff]);

  /** Link z ?scenarioId= do Administracji w trybie Capacity (np. powrót z podstron). */
  const adminQuery = scenarioNavQuery(activeScenarioId);

  useEffect(() => {
    const sp = new URLSearchParams(location.search);
    const sid = Number(sp.get('scenarioId'));
    if (Number.isFinite(sid) && sid > 0) {
      setAppSection('scenarios');
      return;
    }
    if (location.pathname === '/call-offs' || location.pathname.startsWith('/call-offs/')) {
      setAppSection('calloffs');
    }
  }, [location.search, location.pathname, setAppSection]);

  useEffect(() => {
    if (appSection !== 'scenarios') return;
    if (location.pathname === '/scenariusze' || location.pathname.startsWith('/scenariusze/')) return;
    const sp = new URLSearchParams(location.search);
    const urlSid = Number(sp.get('scenarioId'));
    if (Number.isFinite(urlSid) && urlSid > 0) return;
    if (activeScenarioId != null && activeScenarioId > 0) {
      sp.set('scenarioId', String(activeScenarioId));
      navigate({ pathname: location.pathname, search: sp.toString() }, { replace: true });
    }
  }, [appSection, activeScenarioId, location.pathname, location.search, navigate]);

  /** W obszarze scenariuszy: kalkulator, maszyny (linia tylko w scenariuszu), historia i lista scenariuszy. */
  useEffect(() => {
    if (appSection !== 'scenarios') return;
    const p = location.pathname;
    const allowed =
      p === '/kalkulator' ||
      p === '/administracja' ||
      p === '/administracja/historia-zmian' ||
      p === '/administracja/instrukcja' ||
      p === '/historia-zmian' ||
      p === '/scenariusze' ||
      p.startsWith('/scenariusze/') ||
      p === '/maszyny' ||
      p.startsWith('/maszyny/');
    if (allowed) return;
    const sp = new URLSearchParams();
    if (activeScenarioId != null && activeScenarioId > 0) sp.set('scenarioId', String(activeScenarioId));
    const q = sp.toString();
    navigate(`/kalkulator${q ? `?${q}` : ''}`, { replace: true });
  }, [appSection, location.pathname, activeScenarioId, navigate]);

  useEffect(() => {
    if (appSection !== 'calloffs') return;
    const p = location.pathname;
    const allowed =
      p === '/call-offs' ||
      p.startsWith('/call-offs/') ||
      p === '/administracja' ||
      p === '/administracja/historia-zmian' ||
      p === '/administracja/instrukcja' ||
      p === '/historia-zmian';
    if (allowed) return;
    if (activeCallOffId != null && activeCallOffId > 0) {
      navigate(`/call-offs/${activeCallOffId}`, { replace: true });
    } else {
      navigate('/call-offs', { replace: true });
    }
  }, [appSection, location.pathname, activeCallOffId, navigate]);

  const scenarioMode = activeScenarioId != null && activeScenarioId > 0;
  const scenarioChrome = appSection === 'scenarios';
  const callOffChrome = appSection === 'calloffs';
  const theme = workspaceThemes[appSection];
  const headerAccent = theme.accent;
  const navTextMuted = workspaceAccentMuted(theme.accent);

  const switchSection = useCallback(
    async (next: AppSection) => {
      if (next === appSection) return;
      setAppSection(next);
      if (next === 'scenarios') {
        clearActiveCallOff();
        let sid = activeScenarioId;
        if (sid == null || sid <= 0) {
          const pick = await pickLatestScenario();
          if (pick) {
            setActiveScenario(pick.id, pick.name);
            sid = pick.id;
          }
        }
        if (sid != null && sid > 0) {
          const sp = new URLSearchParams(location.search);
          sp.set('scenarioId', String(sid));
          navigate({ pathname: '/kalkulator', search: sp.toString() }, { replace: true });
        } else {
          navigate('/kalkulator', { replace: true });
        }
      } else if (next === 'calloffs') {
        clearActiveScenario();
        let cid = activeCallOffId;
        if (cid == null || cid <= 0) {
          const pick = await pickLatestCallOff();
          if (pick) {
            setActiveCallOff(pick.id, pick.name);
            cid = pick.id;
          }
        }
        if (cid != null && cid > 0) {
          navigate(`/call-offs/${cid}`, { replace: true });
        } else {
          navigate('/call-offs', { replace: true });
        }
      } else {
        clearActiveScenario();
        clearActiveCallOff();
        const path = location.pathname;
        const workspaceOnlyRoute =
          path === '/scenariusze' ||
          path.startsWith('/scenariusze/') ||
          path === '/call-offs' ||
          path.startsWith('/call-offs/');
        if (workspaceOnlyRoute) {
          navigate('/kalkulator', { replace: true });
        } else {
          navigate({ pathname: location.pathname, search: '' }, { replace: true });
        }
      }
    },
    [
      appSection,
      setAppSection,
      activeScenarioId,
      activeCallOffId,
      setActiveScenario,
      setActiveCallOff,
      clearActiveScenario,
      clearActiveCallOff,
      navigate,
      location.pathname,
      location.search,
    ]
  );

  const capacityMainNav: { path: string; labelKey: string; end?: boolean; permission: string; isActivePath?: (pathname: string) => boolean }[] = [
    { path: '/kalkulator', labelKey: 'layout.calculator', end: true, permission: 'calculator.view' },
    { path: '/maszyny', labelKey: 'layout.machines', permission: 'machines.view' },
    { path: '/projekty', labelKey: 'layout.projects', permission: 'projects.view' },
    { path: '/detale', labelKey: 'layout.details', permission: 'designations.view' },
    { path: '/wizualizacja-danych', labelKey: 'layout.dataVisualization', permission: 'admin_data_viz.view' },
  ];

  const scenarioMainNav: { path: string; labelKey: string; end?: boolean; permission: string; isActivePath?: (pathname: string) => boolean }[] = [
    { path: '/kalkulator', labelKey: 'layout.calculator', end: true, permission: 'calculator.view' },
    { path: '/maszyny', labelKey: 'layout.machines', permission: 'machines.view' },
  ];

  const callOffMainNav: { path: string; labelKey: string; end?: boolean; permission: string; isActivePath?: (pathname: string) => boolean }[] = [
    {
      path: activeCallOffId != null && activeCallOffId > 0 ? `/call-offs/${activeCallOffId}` : '/call-offs',
      labelKey: 'layout.calculator',
      end: true,
      permission: 'call_offs.view',
      isActivePath: (pathname) => /^\/call-offs\/\d+/.test(pathname),
    },
  ];

  const mainNav = (
    callOffChrome ? callOffMainNav : scenarioChrome ? scenarioMainNav : capacityMainNav
  ).filter((item) => hasPermission(item.permission));

  const scenarioListNav = { path: '/scenariusze', labelKey: 'layout.scenarioList', permission: 'scenarios.view', end: true as const };
  const callOffListNav = {
    path: '/call-offs',
    labelKey: 'layout.callOffList',
    permission: 'call_offs.view',
    end: true as const,
    isActivePath: (pathname: string) => pathname === '/call-offs',
  };

  const workspaceChrome = scenarioChrome || callOffChrome;

  const showAdminLink =
    workspaceChrome ||
    hasAnyPermission([
      'admin_database.view',
      'admin_settings.view',
      'admin_ocu.view',
      'admin_attachments.view',
      'change_history.view',
      'user_management.view',
      'role_management.view',
    ]);

  const showScenariosWorkspace = hasPermission('scenarios.view');
  const showCallOffsWorkspace = hasPermission('call_offs.view');

  const callOffMode = activeCallOffId != null && activeCallOffId > 0;

  useEffect(() => {
    setNavMenuOpen(false);
    setToolsMenuOpen(false);
  }, [location.pathname, location.search]);

  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;

    let raf = 0;
    const GAP = 16;
    const TOGGLE_W = 52;

    const recompute = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const headerW = header.clientWidth;
        if (headerW <= 0) return;
        const brandW = brandRef.current?.offsetWidth ?? 0;
        const navW = navMeasureRef.current?.scrollWidth ?? 0;
        const toolsW = toolsMeasureRef.current?.scrollWidth ?? 0;
        const trailW = trailingMeasureRef.current?.scrollWidth ?? 0;
        const available = headerW - brandW - GAP * 3;
        const needFull = navW + toolsW + trailW;
        const needRightCollapsed = navW + TOGGLE_W + trailW;
        let next: HeaderCollapse = 'none';
        if (needFull > available) next = 'right';
        if (needRightCollapsed > available) next = 'both';
        setHeaderCollapse((prev) => (prev === next ? prev : next));
      });
    };

    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(header);
    window.addEventListener('resize', recompute);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', recompute);
    };
  }, [
    mainNav.length,
    showAdminLink,
    showScenariosWorkspace,
    showCallOffsWorkspace,
    appSection,
    scenarioChrome,
    callOffChrome,
    t,
  ]);

  const closeNavMenu = useCallback(() => setNavMenuOpen(false), []);
  const closeToolsMenu = useCallback(() => setToolsMenuOpen(false), []);

  const renderNavLinks = (menu: boolean) => (
    <>
      {mainNav.map(({ path, labelKey, end, isActivePath }) => (
        <MainNavLink
          key={path}
          path={path}
          label={t(labelKey)}
          end={end}
          isActivePath={isActivePath}
          appSection={appSection}
          activeScenarioId={activeScenarioId}
          setActiveScenario={setActiveScenario}
          navigate={navigate}
          navTheme={theme}
          menu={menu}
          onNavigate={menu ? closeNavMenu : undefined}
        />
      ))}
      {appSection === 'scenarios' && showScenariosWorkspace && (
        <MainNavLink
          key={scenarioListNav.path}
          path={scenarioListNav.path}
          label={t(scenarioListNav.labelKey)}
          end={scenarioListNav.end}
          appSection={appSection}
          activeScenarioId={activeScenarioId}
          setActiveScenario={setActiveScenario}
          navigate={navigate}
          navTheme={theme}
          menu={menu}
          onNavigate={menu ? closeNavMenu : undefined}
        />
      )}
      {appSection === 'calloffs' && showCallOffsWorkspace && (
        <MainNavLink
          key={callOffListNav.path}
          path={callOffListNav.path}
          label={t(callOffListNav.labelKey)}
          end={callOffListNav.end}
          isActivePath={callOffListNav.isActivePath}
          appSection={appSection}
          activeScenarioId={activeScenarioId}
          setActiveScenario={setActiveScenario}
          navigate={navigate}
          navTheme={theme}
          menu={menu}
          onNavigate={menu ? closeNavMenu : undefined}
        />
      )}
      {showAdminLink && (
        <NavLink
          to={`/administracja${adminQuery}`}
          className={menu ? 'app-header-menu-link' : undefined}
          onClick={menu ? closeNavMenu : undefined}
          style={({ isActive }) => ({
            display: menu ? 'block' : undefined,
            width: menu ? '100%' : undefined,
            boxSizing: 'border-box',
            padding: menu ? '0.55rem 0.75rem' : '0.5rem 0.75rem',
            color: isActive ? '#fff' : navTextMuted,
            textDecoration: 'none',
            borderRadius: 4,
            background: isActive ? theme.accent : 'transparent',
            whiteSpace: 'nowrap',
          })}
        >
          {t('layout.administration')}
        </NavLink>
      )}
    </>
  );

  const workspaceSwitcherStyle = (section: AppSection, stacked: boolean, withBorder: boolean): CSSProperties => ({
    padding: '0.45rem 0.85rem',
    border: 'none',
    borderLeft: withBorder ? `1px solid ${headerAccent}` : 'none',
    borderTop: stacked && withBorder ? `1px solid ${headerAccent}` : 'none',
    cursor:
      section === 'capacity' ||
      (section === 'scenarios' && showScenariosWorkspace) ||
      (section === 'calloffs' && showCallOffsWorkspace)
        ? 'pointer'
        : 'not-allowed',
    fontSize: 13,
    fontWeight: 600,
    whiteSpace: 'nowrap',
    opacity:
      section === 'capacity' ||
      (section === 'scenarios' && showScenariosWorkspace) ||
      (section === 'calloffs' && showCallOffsWorkspace)
        ? 1
        : 0.45,
    background: appSection === section ? workspaceThemes[section].accent : 'transparent',
    color: appSection === section ? '#fff' : workspaceAccentMuted(workspaceThemes[appSection].accent),
    width: stacked ? '100%' : undefined,
    textAlign: stacked ? 'left' : 'center',
  });

  const renderToolsBody = (stacked: boolean) => (
    <>
      {scenarioChrome && showScenariosWorkspace && <ScenarioNewControl activateOnCreate />}
      {callOffChrome && showCallOffsWorkspace && <CallOffNewComparisonControl />}
      <div
        style={{
          display: stacked ? 'flex' : 'inline-flex',
          alignItems: stacked ? 'stretch' : 'center',
          flexDirection: stacked ? 'column' : 'row',
          gap: stacked ? 8 : 10,
          fontSize: 13,
          userSelect: 'none',
          color: navTextMuted,
        }}
        title={t('layout.contractualVolumesTitle')}
      >
        <button
          type="button"
          role="switch"
          aria-checked={useContractualVolumes}
          onClick={() => setUseContractualVolumes(!useContractualVolumes)}
          style={{
            position: 'relative',
            width: 46,
            height: 26,
            borderRadius: 13,
            border: `2px solid ${headerAccent}`,
            background: useContractualVolumes ? contractualFrameColor : '#e0e0e0',
            cursor: 'pointer',
            flexShrink: 0,
            padding: 0,
            transition: 'background 0.18s ease',
            boxSizing: 'border-box',
            alignSelf: stacked ? 'flex-start' : undefined,
          }}
        >
          <span
            aria-hidden
            style={{
              position: 'absolute',
              top: 3,
              left: useContractualVolumes ? 22 : 3,
              width: 18,
              height: 18,
              borderRadius: '50%',
              background: '#fff',
              boxShadow: '0 1px 4px rgba(0,0,0,0.28)',
              transition: 'left 0.18s ease',
            }}
          />
        </button>
        <span style={{ fontWeight: 600, cursor: 'default' }}>{t('layout.contractualVolumes')}</span>
      </div>
      <div
        style={{
          display: stacked ? 'flex' : 'inline-flex',
          flexDirection: stacked ? 'column' : 'row',
          borderRadius: 10,
          overflow: 'hidden',
          border: `2px solid ${headerAccent}`,
          boxSizing: 'border-box',
          width: stacked ? '100%' : undefined,
        }}
        role="group"
        aria-label={t('layout.workspaceAria')}
      >
        <button type="button" onClick={() => void switchSection('capacity')} style={workspaceSwitcherStyle('capacity', stacked, false)}>
          {t('layout.versionCapacity')}
        </button>
        <button
          type="button"
          onClick={() => void switchSection('scenarios')}
          disabled={!showScenariosWorkspace}
          style={workspaceSwitcherStyle('scenarios', stacked, true)}
        >
          {t('layout.scenarios')}
        </button>
        <button
          type="button"
          onClick={() => void switchSection('calloffs')}
          disabled={!showCallOffsWorkspace}
          style={workspaceSwitcherStyle('calloffs', stacked, true)}
        >
          {t('layout.callOffs')}
        </button>
      </div>
    </>
  );

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: theme.page_bg,
      }}
    >
      {scenarioChrome && (
        <div
          style={{
            background: workspaceBannerGradient(workspaceThemes.scenarios),
            color: '#fff',
            padding: '0.4rem 1rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '1rem',
            flexWrap: 'wrap',
            fontSize: 14,
            textAlign: 'center',
          }}
        >
          <span>
            <strong>{t('layout.scenarioWorkspace')}</strong>
            {scenarioMode ? (
              <span style={{ opacity: 0.92 }}> {t('layout.scenarioWithActive')}</span>
            ) : (
              <span style={{ opacity: 0.9 }}> {t('layout.scenarioNoActive')}</span>
            )}
          </span>
        </div>
      )}
      {callOffChrome && (
        <div
          style={{
            background: workspaceBannerGradient(workspaceThemes.calloffs),
            color: '#fff',
            padding: '0.4rem 1rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '1rem',
            flexWrap: 'wrap',
            fontSize: 14,
            textAlign: 'center',
          }}
        >
          <span>
            <strong>{t('layout.callOffWorkspace')}</strong>
            {callOffMode ? (
              <span style={{ opacity: 0.92 }}> {t('layout.callOffWithActive')}</span>
            ) : (
              <span style={{ opacity: 0.9 }}> {t('layout.callOffNoActive')}</span>
            )}
          </span>
        </div>
      )}
      <header
        ref={headerRef}
        className="app-header"
        data-collapse={headerCollapse}
        style={{
          background: theme.header_bg,
          color: '#333',
          padding: '0.5rem 1.25rem',
          minHeight: 52,
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          flexWrap: 'nowrap',
          borderBottom: `2px solid ${headerAccent}`,
          boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
          position: 'relative',
        }}
      >
        <div className="app-header-measure-row" aria-hidden>
          <nav ref={navMeasureRef} className="app-header-measure-group">
            {renderNavLinks(false)}
          </nav>
          <div ref={toolsMeasureRef} className="app-header-measure-group">
            {renderToolsBody(false)}
          </div>
          <div ref={trailingMeasureRef} className="app-header-measure-group">
            <span style={{ width: 44, height: 32, display: 'inline-block' }} />
            <span style={{ width: 44, height: 32, display: 'inline-block' }} />
            <span style={{ width: 128, height: 32, display: 'inline-block' }} />
          </div>
        </div>

        <span
          ref={brandRef}
          className="app-header-brand"
          style={{
            fontWeight: 700,
            fontSize: '1.25rem',
            color: navTextMuted,
            display: 'flex',
            alignItems: 'baseline',
            flexWrap: 'nowrap',
            gap: '0.25rem 0.75rem',
            flexShrink: 0,
            minWidth: 0,
          }}
        >
          {ocuFeatureEnabled && !workspaceChrome ? (
            <button
              type="button"
              onClick={toggleCalculationProfile}
              title={t('layout.calculationProfileToggle')}
              style={{
                fontWeight: 700,
                fontSize: '1.25rem',
                color: navTextMuted,
                background: 'transparent',
                border: calculationProfile === 'ocu' ? `2px solid ${theme.accent}` : '2px solid transparent',
                borderRadius: 4,
                padding: calculationProfile === 'ocu' ? '2px 8px' : '2px 0',
                cursor: 'pointer',
                lineHeight: 1.2,
              }}
            >
              {calculationProfile === 'ocu' ? 'OCU' : 'Capacity'}
            </button>
          ) : (
            'Capacity'
          )}
          {scenarioChrome && scenarioMode && activeScenarioName ? (
            <Link
              to={`/scenariusze/${activeScenarioId}`}
              title={t('layout.openScenarioPreview')}
              className="app-header-brand-meta"
              style={{
                fontWeight: 600,
                fontSize: '1.05rem',
                color: navTextMuted,
                textDecoration: 'none',
                cursor: 'pointer',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: '28vw',
              }}
            >
              · {activeScenarioName}
              <span style={{ fontWeight: 500, fontSize: '0.85rem', opacity: 0.88, marginLeft: 8 }}>#{activeScenarioId}</span>
            </Link>
          ) : scenarioChrome && scenarioMode && activeScenarioId ? (
            <Link
              to={`/scenariusze/${activeScenarioId}`}
              title={t('layout.openScenarioPreview')}
              className="app-header-brand-meta"
              style={{
                fontWeight: 600,
                fontSize: '1rem',
                color: navTextMuted,
                opacity: 0.95,
                textDecoration: 'none',
                cursor: 'pointer',
              }}
            >
              {t('layout.scenarioHash', { id: activeScenarioId })}
            </Link>
          ) : callOffChrome && callOffMode && activeCallOffName ? (
            <Link
              to={`/call-offs/${activeCallOffId}`}
              className="app-header-brand-meta"
              style={{
                fontWeight: 600,
                fontSize: '1.05rem',
                color: navTextMuted,
                textDecoration: 'none',
                cursor: 'pointer',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: '28vw',
              }}
            >
              · {activeCallOffName}
              <span style={{ fontWeight: 500, fontSize: '0.85rem', opacity: 0.88, marginLeft: 8 }}>#{activeCallOffId}</span>
            </Link>
          ) : callOffChrome && callOffMode && activeCallOffId ? (
            <Link
              to={`/call-offs/${activeCallOffId}`}
              className="app-header-brand-meta"
              style={{
                fontWeight: 600,
                fontSize: '1rem',
                color: navTextMuted,
                opacity: 0.95,
                textDecoration: 'none',
                cursor: 'pointer',
              }}
            >
              · #{activeCallOffId}
            </Link>
          ) : null}
        </span>

        {headerCollapse !== 'both' ? (
          <nav className="app-header-nav-inline" style={{ display: 'flex', gap: '0.25rem', flex: 1, minWidth: 0 }}>
            {renderNavLinks(false)}
          </nav>
        ) : (
          <HeaderOverflowMenu
            label={t('layout.navMenu')}
            open={navMenuOpen}
            onToggle={() => {
              setNavMenuOpen((v) => !v);
              setToolsMenuOpen(false);
            }}
            onClose={closeNavMenu}
            accentColor={headerAccent}
            icon="nav"
            align="left"
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{renderNavLinks(true)}</div>
          </HeaderOverflowMenu>
        )}

        <div
          className="app-header-trailing"
          style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.65rem', flexShrink: 0 }}
        >
          {headerCollapse === 'none' ? (
            <div className="app-header-tools-inline" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              {renderToolsBody(false)}
            </div>
          ) : (
            <HeaderOverflowMenu
              label={t('layout.toolsMenu')}
              open={toolsMenuOpen}
              onToggle={() => {
                setToolsMenuOpen((v) => !v);
                setNavMenuOpen(false);
              }}
              onClose={closeToolsMenu}
              accentColor={headerAccent}
              icon="tools"
              align="right"
            >
              {renderToolsBody(true)}
            </HeaderOverflowMenu>
          )}
          <UserMenu accentColor={headerAccent} scenarioChrome={scenarioChrome} />
          <LanguageSwitcher accentColor={headerAccent} />
          <Link
            to="/kalkulator"
            title={t('layout.logoTitle')}
            className="app-header-logo"
            style={{ display: 'flex', alignItems: 'center', flexShrink: 0, lineHeight: 0 }}
          >
            <img
              src="/logo-autoneum.png"
              alt="Autoneum"
              style={{
                height: 'clamp(25px, min(5.6vmin, 7.7vh), 39px)',
                width: 'auto',
                maxWidth: 'min(36vw, 448px)',
                display: 'block',
                objectFit: 'contain',
              }}
            />
          </Link>
        </div>
      </header>
      <main
        style={{
          flex: 1,
          padding: '1.5rem',
          background: theme.main_bg,
        }}
      >
        {children}
      </main>
    </div>
  );
}
