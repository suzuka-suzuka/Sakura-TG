import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ConfigSection from "./components/ConfigSection.jsx";
import LoginPage from "./components/LoginPage.jsx";
import ToastRegion from "./components/ToastRegion.jsx";
import useConfig from "./hooks/useConfig.js";
import { pathStartsWith, sectionPath } from "./lib/config.js";

const CATEGORY_ICONS = {
  core: "◆",
  roleplay: "✦",
  novelai: "◐",
};

function formatUptime(seconds) {
  if (!Number.isFinite(seconds)) return "服务在线";
  if (seconds < 60) return `已运行 ${seconds} 秒`;
  if (seconds < 3600) return `已运行 ${Math.floor(seconds / 60)} 分钟`;
  if (seconds < 86400) return `已运行 ${Math.floor(seconds / 3600)} 小时`;
  return `已运行 ${Math.floor(seconds / 86400)} 天`;
}

function sectionOwnsPath(section, path) {
  const root = sectionPath(section);
  if (!pathStartsWith(path, root)) return false;
  if (section.type === "array") return true;
  const relative = path.slice(root.length);
  if (relative.length === 0) return true;
  const keys = new Set((section.fields || []).map((field) => field.key));
  return keys.has(String(relative[0] ?? ""));
}

function ErrorSummary({ errors, sections, onSelect }) {
  if (errors.length === 0) return null;
  return (
    <div className="config-alert error-alert">
      <div>
        <strong>配置校验未通过</strong>
        <p>共有 {errors.length} 处需要检查，点击可跳到对应页面。</p>
      </div>
      <div className="error-links">
        {errors.slice(0, 5).map((error, index) => {
          const section = sections.find((entry) =>
            sectionOwnsPath(entry, error.path || [])
          );
          return (
            <button
              type="button"
              key={`${(error.path || []).join(".")}-${index}`}
              onClick={() => section && onSelect(section)}
            >
              {(error.path || []).join(".") || "配置"}：{error.message}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function App() {
  const toastId = useRef(0);
  const [toasts, setToasts] = useState([]);
  const [activeCategory, setActiveCategory] = useState("");
  const [activeSection, setActiveSection] = useState("");
  const [search, setSearch] = useState("");
  const [loginNotice, setLoginNotice] = useState("");

  const notify = useCallback((message, type = "info") => {
    const id = ++toastId.current;
    setToasts((current) => [...current, { id, message, type }]);
    window.setTimeout(
      () => setToasts((current) => current.filter((toast) => toast.id !== id)),
      type === "error" || type === "warning" ? 5200 : 3400
    );
  }, []);

  const config = useConfig(notify);
  const categories = config.schema?.categories || [];
  const sections = config.schema?.sections || [];

  const selectSection = useCallback((section) => {
    if (!section) return;
    setActiveCategory(section.category);
    setActiveSection(section.id);
    setSearch("");
    history.replaceState(null, "", `#${encodeURIComponent(section.id)}`);
  }, []);

  useEffect(() => {
    if (sections.length === 0) return;
    const hash = decodeURIComponent(location.hash.slice(1));
    const desired =
      sections.find((section) => section.id === activeSection) ||
      sections.find((section) => section.id === hash) ||
      sections[0];
    if (desired.id !== activeSection || desired.category !== activeCategory) {
      selectSection(desired);
    }
  }, [
    activeCategory,
    activeSection,
    sections,
    selectSection,
  ]);

  const categorySections = useMemo(
    () => sections.filter((section) => section.category === activeCategory),
    [activeCategory, sections]
  );
  const currentSection =
    sections.find((section) => section.id === activeSection) ||
    categorySections[0];
  const currentCategory =
    categories.find((category) => category.id === activeCategory) ||
    categories[0];

  const categoryErrorCount = (categoryId) =>
    config.errors.filter((error) =>
      sections.some(
        (section) =>
          section.category === categoryId &&
          sectionOwnsPath(section, error.path || [])
      )
    ).length;

  const handleCategoryChange = (categoryId) => {
    const first = sections.find((section) => section.category === categoryId);
    if (first) selectSection(first);
  };

  const handleSave = async () => {
    const result = await config.save();
    if (result.reloginMessage) setLoginNotice(result.reloginMessage);
    if (result.errors?.length) {
      const target = sections.find((section) =>
        sectionOwnsPath(section, result.errors[0].path || [])
      );
      if (target) selectSection(target);
    }
  };

  if (config.phase === "login") {
    return (
      <>
        <LoginPage
          onLogin={async (password) => {
            const result = await config.login(password);
            if (result.ok) setLoginNotice("");
            return result;
          }}
          loading={config.loading}
          notice={loginNotice}
        />
        <ToastRegion toasts={toasts} />
      </>
    );
  }

  if (config.phase === "boot") {
    return (
      <main className="loading-container">
        <div className="spinner" />
        <p>正在连接配置服务…</p>
      </main>
    );
  }

  if (config.phase === "error") {
    return (
      <main className="login-container">
        <section className="login-card service-error-card">
          <div className="login-brand" aria-hidden="true">
            !
          </div>
          <h2>配置服务不可用</h2>
          <p>{config.fatalError}</p>
          <button
            className="btn btn-primary login-submit"
            type="button"
            onClick={config.initialize}
          >
            重新连接
          </button>
        </section>
      </main>
    );
  }

  if (!config.schema || !config.draft || !currentSection) return null;

  return (
    <div className="app-root">
      <ToastRegion toasts={toasts} />

      <div className="app-layout">
        <aside className="left-nav">
          <div className="left-nav-brand">
            <span className="left-nav-brand-icon">🌸</span>
            <span className="left-nav-brand-text">SakuraTG</span>
          </div>
          <div className="left-nav-divider" />
          <div className="left-nav-section">配置</div>

          {categories.map((category) => {
            const errorCount = categoryErrorCount(category.id);
            return (
              <button
                className={`left-nav-item ${
                  category.id === activeCategory ? "active" : ""
                }`}
                type="button"
                key={category.id}
                onClick={() => handleCategoryChange(category.id)}
              >
                <span className="left-nav-icon">
                  {CATEGORY_ICONS[category.id] || "◇"}
                </span>
                <span className="left-nav-label">{category.label}</span>
                {errorCount > 0 && (
                  <span className="nav-error-count">{errorCount}</span>
                )}
              </button>
            );
          })}

          <div className="left-nav-bottom">
            <div className="left-nav-status">
              <span
                className={`status-dot ${
                  config.socketConnected ? "connected" : "disconnected"
                }`}
              />
              <span className="left-nav-status-copy">
                <strong>
                  {config.socketConnected ? "实时监听已连接" : "监听正在重连"}
                </strong>
                <small>{formatUptime(config.status?.uptimeSeconds)}</small>
              </span>
            </div>
            {config.authRequired && (
              <button
                className="btn btn-secondary btn-sm"
                type="button"
                onClick={config.logout}
              >
                退出
              </button>
            )}
          </div>
        </aside>

        <main className="main-content">
          <header className="app-header">
            <div>
              <h1>
                <span className="header-accent">SakuraTG</span> 配置面板
              </h1>
              <p>{config.schema.description}</p>
            </div>
            <div className="header-actions">
              <label className="panel-search">
                <span aria-hidden="true">⌕</span>
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="搜索当前页面"
                />
              </label>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={config.reload}
                disabled={config.loading}
              >
                {config.loading ? "载入中…" : "重新载入"}
              </button>
            </div>
          </header>

          {config.remoteChange && (
            <div className="config-alert warning-alert">
              <div>
                <strong>配置文件已在其他位置修改</strong>
                <p>当前草稿没有被覆盖，请重新载入后再继续编辑。</p>
              </div>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={config.reload}
              >
                重新载入
              </button>
            </div>
          )}

          {config.restartPaths.length > 0 && (
            <div className="config-alert restart-alert">
              <div>
                <strong>部分改动需要重启进程</strong>
                <p>{config.restartPaths.join("、")}</p>
              </div>
              <button
                className="modal-close"
                type="button"
                onClick={config.clearRestart}
                aria-label="关闭提示"
              >
                ✕
              </button>
            </div>
          )}

          <ErrorSummary
            errors={config.errors}
            sections={sections}
            onSelect={selectSection}
          />

          <div className="section-heading">
            <span className="heading-icon" aria-hidden="true">
              {CATEGORY_ICONS[currentCategory?.id] || "◇"}
            </span>
            <span className="heading-accent">{currentCategory?.label}</span>
            <span className="revision-chip">
              {config.dirty ? "有未保存改动" : `版本 ${config.revision.slice(0, 8)}`}
            </span>
          </div>

          <div className="category-tabs" role="tablist">
            {categorySections.map((section) => (
              <button
                className={`category-tab ${
                  section.id === currentSection.id ? "active" : ""
                }`}
                type="button"
                role="tab"
                aria-selected={section.id === currentSection.id}
                key={section.id}
                onClick={() => selectSection(section)}
              >
                {section.title}
              </button>
            ))}
          </div>

          <div className="content-area">
            <ConfigSection
              key={currentSection.id}
              section={currentSection}
              draft={config.draft}
              errors={config.errors}
              secretMask={config.schema.secretMask}
              search={search}
              onChange={config.updateValue}
              loadProviderModels={config.loadProviderModels}
            />
          </div>

          <div className="save-bar">
            <button
              className="btn btn-primary btn-save"
              type="button"
              disabled={!config.dirty || config.saving || Boolean(config.remoteChange)}
              onClick={handleSave}
            >
              {config.saving
                ? "保存中…"
                : config.remoteChange
                  ? "请先重新载入"
                  : config.dirty
                    ? "保存配置"
                    : "无变更"}
            </button>
          </div>
        </main>
      </div>
    </div>
  );
}
