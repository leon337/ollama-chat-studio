interface Props {
  sidebarOpen: boolean;
  drawerOpen: boolean;
  onToggleSidebar: () => void;
  onNewConversation: () => void;
  onOpenModels: () => void;
  onToggleParams: () => void;
  onOpenSettings: () => void;
}

/** Navegação própria; não anuncia módulos sem backend real. */
export function NavigationRail({
  sidebarOpen, drawerOpen, onToggleSidebar, onNewConversation,
  onOpenModels, onToggleParams, onOpenSettings,
}: Props) {
  return (
    <nav className="nav-rail" aria-label="Navegação do Studio">
      <div className="rail-brand" aria-label="Ollama Chat Studio" title="Ollama Chat Studio"><span aria-hidden="true">O</span></div>
      <button className={'rail-action' + (sidebarOpen ? ' active' : '')} type="button"
        aria-label={sidebarOpen ? 'Recolher barra lateral' : 'Expandir barra lateral'}
        aria-expanded={sidebarOpen} title={sidebarOpen ? 'Recolher barra lateral' : 'Expandir barra lateral'}
        onClick={onToggleSidebar}><span aria-hidden="true">☷</span></button>
      <button className="rail-action" type="button" title="Nova conversa" aria-label="Nova conversa"
        onClick={onNewConversation}><span aria-hidden="true">＋</span></button>
      <button className="rail-action" type="button" title="Catálogo de modelos" aria-label="Catálogo de modelos"
        onClick={onOpenModels}><span aria-hidden="true">◇</span></button>
      <button className={'rail-action' + (drawerOpen ? ' active' : '')} type="button" title="Parâmetros do modelo"
        aria-label="Parâmetros do modelo" aria-expanded={drawerOpen} onClick={onToggleParams}>
        <span aria-hidden="true">≡</span>
      </button>
      <div className="rail-spacer" />
      <button className="rail-action" type="button" title="Configurações" aria-label="Configurações do Studio"
        onClick={onOpenSettings}><span aria-hidden="true">⚙</span></button>
    </nav>
  );
}
